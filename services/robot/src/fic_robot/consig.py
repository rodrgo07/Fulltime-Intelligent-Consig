"""Fluxo real: digitação no BMG Consig → ConsigMais (entidade INSS por padrão).

Mapeado a partir do notebook do backoffice (login, abrir digitação, CPF, entidade, Continuar, produto
"Empréstimo Consignado" → Adicionar). O login é humano, na janela do Chrome do robô: o CAPTCHA exige isso
e a senha do BMG nunca passa pelo robô. O perfil biométrico do usuário precisa estar ativo.

AINDA NÃO MAPEADO (por isso o fluxo não tem etapa com efeito e o robô não reserva jobs com ele):
  - escolha de valor/parcela e da tabela de digitação;
  - envio da proposta (a etapa com `side_effect = True`);
  - captura do número de adesão (o `ProposalResult`).
Para continuar o mapeamento sem tocar a fila, use `ensaio.bat` (roda as etapas abaixo e para antes do envio).

O Selenium é importado só dentro das funções: o teste ponta a ponta do banco roda sem ele.
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

from .steps import Flow, InvalidJobData, SessionUnavailable, Step, StepContext, UnexpectedScreen

LOGIN_URL = "https://www.bmgconsig.com.br/Index.do?method=prepare&logout=true"
BMG_HOST = "bmgconsig.com.br"
CONSIGMAIS_HOST = "consigmais.bancobmg.com.br"
DEFAULT_ENTIDADE = "1581"  # INSS

CPF_INPUT = "//input[contains(@aria-label, 'CPF')]"
ENTIDADE_INPUT = "//input[contains(@aria-label, 'Entidade')]"
CONTINUAR = "//button[.//span[normalize-space()='Continuar']]"
PRODUTO_TITULO = "//h2[contains(normalize-space(.), 'Empréstimo Consignado')]"
ADICIONAR_NO_CARD = ".//button[contains(normalize-space(.), 'Adicionar')]"
ADICIONAR = "//button[.//span[normalize-space()='Adicionar']]"


def _sel() -> SimpleNamespace:
    from selenium.common import exceptions  # noqa: PLC0415
    from selenium.webdriver.common.by import By  # noqa: PLC0415
    from selenium.webdriver.support import expected_conditions as EC  # noqa: PLC0415, N812
    from selenium.webdriver.support.ui import WebDriverWait  # noqa: PLC0415

    return SimpleNamespace(By=By, EC=EC, Wait=WebDriverWait, exc=exceptions)


def _wait(driver: Any, timeout: float) -> Any:
    s = _sel()
    return s.Wait(driver, timeout, ignored_exceptions=(s.exc.StaleElementReferenceException,))


def _click_fresh(driver: Any, xpath: str, timeout: float, what: str) -> Any:
    """Procura o elemento de novo a cada tentativa (a tela troca e a referência antiga fica 'stale')."""
    s = _sel()

    def attempt(d: Any) -> Any:
        try:
            el = s.EC.element_to_be_clickable((s.By.XPATH, xpath))(d)
            if el:
                el.click()
            return el
        except (s.exc.StaleElementReferenceException, s.exc.ElementClickInterceptedException):
            return False

    try:
        return _wait(driver, timeout).until(attempt)
    except s.exc.TimeoutException as exc:
        raise UnexpectedScreen(f"{what} não apareceu") from exc


def _cpf(ctx: StepContext) -> str:
    cpf = re.sub(r"\D", "", str(ctx.require("cpf")))
    if len(cpf) != 11:
        raise InvalidJobData("CPF com tamanho inválido")
    return cpf


def _entidade(ctx: StepContext) -> str:
    entidade = str(ctx.payload.get("entidade") or DEFAULT_ENTIDADE).strip()
    if not entidade.isdigit():
        raise InvalidJobData("entidade inválida")
    return entidade


def session_probe(driver: Any) -> bool:
    """Logado = alguma janela no ConsigMais ou no BMG Consig com o menu lateral (leftFrame)."""
    s = _sel()
    try:
        current = driver.current_window_handle
    except Exception:  # noqa: BLE001 — a aba atual foi fechada pela pessoa
        current = None
    try:
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            url = driver.current_url or ""
            if CONSIGMAIS_HOST in url:
                return True
            if BMG_HOST in url:
                driver.switch_to.default_content()
                if driver.find_elements(s.By.ID, "leftFrame"):
                    return True
        return False
    finally:
        if current is not None:
            try:
                driver.switch_to.window(current)
            except Exception:  # noqa: BLE001
                pass


class AbrirDigitacao(Step):
    """BMG Consig → menu lateral → 'Nova Plataforma' (link-digitacao) → aba nova do ConsigMais."""

    name = "abrir_digitacao"
    timeout_s = 60

    def run(self, driver: Any, ctx: StepContext) -> None:
        s = _sel()
        main, leftovers = None, []
        for handle in list(driver.window_handles):
            driver.switch_to.window(handle)
            url = driver.current_url or ""
            if CONSIGMAIS_HOST in url:
                leftovers.append(handle)
            elif BMG_HOST in url and main is None:
                main = handle
        if main is None:
            raise SessionUnavailable("janela do BMG Consig não encontrada")
        for handle in leftovers:  # aba do job anterior: cada proposta começa do zero
            driver.switch_to.window(handle)
            driver.close()
        driver.switch_to.window(main)
        driver.switch_to.default_content()
        before = set(driver.window_handles)
        wait = _wait(driver, self.timeout_s)
        try:
            frame = wait.until(s.EC.presence_of_element_located((s.By.ID, "leftFrame")))
        except s.exc.TimeoutException as exc:
            raise SessionUnavailable("menu do BMG Consig não apareceu (login expirado?)") from exc
        driver.switch_to.frame(frame)
        try:
            wait.until(s.EC.element_to_be_clickable((s.By.ID, "link-digitacao"))).click()
        except s.exc.TimeoutException as exc:
            raise UnexpectedScreen("link da digitação não apareceu") from exc
        finally:
            driver.switch_to.default_content()
        try:
            wait.until(lambda d: set(d.window_handles) - before)
        except s.exc.TimeoutException as exc:
            raise UnexpectedScreen("a aba do ConsigMais não abriu (perfil biométrico ativo?)") from exc
        driver.switch_to.window(next(iter(set(driver.window_handles) - before)))
        try:
            wait.until(lambda d: CONSIGMAIS_HOST in (d.current_url or ""))
        except s.exc.TimeoutException as exc:
            raise UnexpectedScreen("a aba nova não é o ConsigMais") from exc


class IdentificarCliente(Step):
    """CPF + entidade (lista: '<código> - <nome>') + Continuar."""

    name = "identificar_cliente"
    timeout_s = 60

    def run(self, driver: Any, ctx: StepContext) -> None:
        cpf, entidade = _cpf(ctx), _entidade(ctx)  # valida antes de tocar a tela
        s = _sel()
        wait = _wait(driver, self.timeout_s)
        try:
            campo = wait.until(s.EC.element_to_be_clickable((s.By.XPATH, CPF_INPUT)))
        except s.exc.TimeoutException as exc:
            raise UnexpectedScreen("campo CPF não apareceu") from exc
        campo.click()
        campo.send_keys(cpf)
        campo = wait.until(s.EC.element_to_be_clickable((s.By.XPATH, ENTIDADE_INPUT)))
        campo.click()
        campo.send_keys(entidade)
        _click_fresh(driver, f"//*[@role='listbox']//*[starts-with(normalize-space(.), '{entidade} - ')]",
                     self.timeout_s, "opção da entidade")
        _click_fresh(driver, CONTINUAR, self.timeout_s, "botão Continuar")


class ConfirmarCadastro(Step):
    """Cadastro já completo: Continuar de novo até aparecer a lista de produtos.

    Cadastro incompleto (preencher com o extrato de margem e a UF pelo DDD) ainda não foi mapeado:
    a etapa falha antes do envio e a solicitação vai para a pessoa resolver no ConsigMais.
    """

    name = "confirmar_cadastro"
    timeout_s = 90

    def run(self, driver: Any, ctx: StepContext) -> None:
        s = _sel()
        _click_fresh(driver, CONTINUAR, self.timeout_s, "botão Continuar do cadastro")
        try:
            _wait(driver, self.timeout_s).until(s.EC.presence_of_element_located((s.By.XPATH, PRODUTO_TITULO)))
        except s.exc.TimeoutException as exc:
            raise UnexpectedScreen("lista de produtos não apareceu (cadastro incompleto?)") from exc


class EscolherProduto(Step):
    """Card 'Empréstimo Consignado' → Adicionar."""

    name = "escolher_produto"
    timeout_s = 60

    def run(self, driver: Any, ctx: StepContext) -> None:
        s = _sel()
        wait = _wait(driver, self.timeout_s)
        titulo = wait.until(s.EC.presence_of_element_located((s.By.XPATH, PRODUTO_TITULO)))
        card = titulo.find_element(s.By.XPATH, "..")
        try:
            botao = card.find_element(s.By.XPATH, ADICIONAR_NO_CARD)
        except s.exc.NoSuchElementException as exc:
            raise UnexpectedScreen("botão Adicionar do empréstimo consignado não encontrado") from exc
        botao.click()
        try:
            wait.until(s.EC.staleness_of(botao))  # a tela de valores substitui a lista de produtos
        except s.exc.TimeoutException as exc:
            raise UnexpectedScreen("a tela de valores não abriu") from exc


class EscolherValorTabela(Step):
    """Tela de valores: aceita o valor e a tabela padrão e clica Adicionar.

    Valor/parcela específicos e a escolha da tabela de digitação ainda não foram mapeados.
    """

    name = "escolher_valor_tabela"
    timeout_s = 60

    def run(self, driver: Any, ctx: StepContext) -> None:
        _click_fresh(driver, ADICIONAR, self.timeout_s, "botão Adicionar da tela de valores")


def consig_flow() -> Flow:
    return Flow(id="consig", version=1, steps=[
        AbrirDigitacao(), IdentificarCliente(), ConfirmarCadastro(), EscolherProduto(), EscolherValorTabela(),
    ])

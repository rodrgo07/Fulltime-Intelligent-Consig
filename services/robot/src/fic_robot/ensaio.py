"""Ensaio do fluxo do Consig: `python -m fic_robot.ensaio` (o ensaio.bat faz isso).

Roda as etapas já mapeadas com um CPF digitado no terminal e PARA ANTES de qualquer etapa com efeito.
Não fala com o Supabase, não reserva job e não grava o CPF em lugar nenhum. Serve para o backoffice
conferir o mapeamento e continuar a partir da tela em que o ensaio parou.
Feche o robô antes: os dois usam o mesmo perfil do Chrome.
"""

from __future__ import annotations

import getpass
import sys

from . import redact as log
from .__main__ import HOME, chrome_browser, load_env_file
from .consig import DEFAULT_ENTIDADE, consig_flow
from .steps import StepContext


def main() -> int:
    load_env_file(HOME / "robo.env")
    browser = chrome_browser()
    try:
        browser.open_consig()
        input("Faça o login no BMG Consig na janela do Chrome e pressione ENTER aqui...")
        if browser.session_state() != "authenticated":
            print("Login não reconhecido (menu do BMG Consig não encontrado). Confira a janela e tente de novo.")
            return 1
        cpf = getpass.getpass("CPF do cliente (não aparece na tela): ")
        entidade = input(f"Entidade [{DEFAULT_ENTIDADE}]: ").strip() or DEFAULT_ENTIDADE
        ctx = StepContext(job_id="ensaio", request_id="ensaio", public_ref="ENSAIO", attempt=1,
                          payload={"cpf": cpf, "entidade": entidade}, fields=[])
        del cpf
        try:
            for step in consig_flow().steps:
                if step.side_effect:
                    print(f"Parando antes de '{step.name}' (etapa com efeito: o ensaio nunca envia proposta).")
                    break
                print(f"-> {step.name}...", flush=True)
                try:
                    step.run(browser.driver, ctx)
                except Exception as exc:  # noqa: BLE001
                    print(f"   falhou: {getattr(exc, 'code', type(exc).__name__)}: {log.safe_message(exc)}")
                    break
                print("   ok")
            else:
                print("Etapas mapeadas concluídas. O envio da proposta ainda não está mapeado.")
        finally:
            ctx.payload.clear()
        input("Confira a tela no Chrome. ENTER fecha o navegador...")
        return 0
    finally:
        browser.quit()


if __name__ == "__main__":
    sys.exit(main())

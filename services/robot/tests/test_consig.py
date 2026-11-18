"""Fluxo do Consig sem navegador: contrato com o formulário, trava de produção e sonda de sessão."""

from __future__ import annotations

from typing import Any

import pytest

from fic_robot import consig
from fic_robot.browser import ChromeBrowser
from fic_robot.flows import select_flow
from fic_robot.steps import InvalidJobData, StepContext

CPF = "52998224725"  # fictício


def ctx(**payload: Any) -> StepContext:
    return StepContext(job_id="j", request_id="r", public_ref="FIC-1", attempt=1, payload=payload, fields=[])


class FakeSwitch:
    def __init__(self, drv: FakeDriver) -> None:
        self.drv = drv

    def window(self, handle: str) -> None:
        if handle not in self.drv.windows:
            raise RuntimeError("no such window")
        self.drv.current = handle

    def default_content(self) -> None:
        pass


class FakeDriver:
    def __init__(self, windows: dict[str, tuple[str, bool]], current: str) -> None:
        self.windows = windows  # handle -> (url, tem leftFrame)
        self.current = current
        self.switch_to = FakeSwitch(self)

    @property
    def window_handles(self) -> list[str]:
        return list(self.windows)

    @property
    def current_window_handle(self) -> str:
        return self.current

    @property
    def current_url(self) -> str:
        return self.windows[self.current][0]

    def find_elements(self, by: str, value: str) -> list[object]:
        return [object()] if value == "leftFrame" and self.windows[self.current][1] else []


def test_production_flow_stays_off_until_submission_is_mapped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FIC_FAKE_FLOW", raising=False)
    flow = consig.consig_flow()
    assert not flow.complete
    assert not any(s.side_effect for s in flow.steps)
    assert select_flow() is None


def test_fake_flow_is_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIC_FAKE_FLOW", "1")
    flow = select_flow()
    assert flow is not None and flow.complete


@pytest.mark.parametrize("payload", [{}, {"cpf": "123"}, {"cpf": CPF, "entidade": "1581' or '1'='1"}])
def test_identificar_cliente_validates_before_touching_the_screen(payload: dict[str, Any]) -> None:
    with pytest.raises(InvalidJobData):
        consig.IdentificarCliente().run(None, ctx(**payload))


def test_cpf_accepts_mask_and_default_entidade() -> None:
    assert consig._cpf(ctx(cpf="529.982.247-25")) == CPF
    assert consig._entidade(ctx(cpf=CPF)) == consig.DEFAULT_ENTIDADE


def test_probe_logged_in_on_bmg_menu_and_restores_window() -> None:
    drv = FakeDriver({"a": ("https://example.test", False), "b": (f"https://www.{consig.BMG_HOST}/x", True)}, "a")
    assert consig.session_probe(drv) is True
    assert drv.current == "a"


def test_probe_logged_in_on_consigmais_tab() -> None:
    drv = FakeDriver({"a": (f"https://{consig.CONSIGMAIS_HOST}/", False)}, "a")
    assert consig.session_probe(drv) is True


def test_probe_logged_out_on_login_page() -> None:
    drv = FakeDriver({"a": (consig.LOGIN_URL, False)}, "a")
    assert consig.session_probe(drv) is False


def test_open_consig_does_not_navigate_to_logout_url_when_logged_in() -> None:
    drv = FakeDriver({"a": (f"https://www.{consig.BMG_HOST}/menu", True)}, "a")
    navigated: list[str] = []
    drv.get = navigated.append  # type: ignore[attr-defined]
    browser = ChromeBrowser(profile_dir=None, consig_url=consig.LOGIN_URL, probe=consig.session_probe)  # type: ignore[arg-type]
    browser._driver = drv
    browser._alive = lambda: True  # type: ignore[method-assign]
    browser.open_consig()
    assert navigated == []
    drv.windows["a"] = (consig.LOGIN_URL, False)
    browser.open_consig()
    assert navigated == [consig.LOGIN_URL]

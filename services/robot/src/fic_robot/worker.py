"""Laço da fila: comandos do painel → reenvio de pendentes → reserva → execução → relatório.

Regras que não podem quebrar:
- Nenhum job novo enquanto houver resultado pendente, robô pausado, fluxo ausente ou Consig sem login.
- O ponto sem retorno é registrado ANTES da etapa com efeito. Depois dele, erro vira escalonamento.
- O número de adesão vai para pending-results.json antes de qualquer chamada ao banco.
- Mensagens de erro saem redigidas.
"""

from __future__ import annotations

from typing import Any, Protocol

from . import redact as log
from .api import ApiError, Rpc
from .pending import PendingResult, PendingResults
from .steps import Flow, ProposalResult, StepContext, UnexpectedScreen


class Browser(Protocol):
    driver: Any

    def session_state(self) -> str: ...  # 'authenticated' | 'logged_out' | 'unknown'

    def open_consig(self) -> None: ...


class RestartRequested(Exception):
    """O painel pediu reinício: o processo sai e o iniciar.bat abre de novo."""


class Worker:
    def __init__(self, api: Rpc, browser: Browser, flow: Flow | None, pending: PendingResults,
                 worker_id: str, version: str) -> None:
        self.api = api
        self.browser = browser
        self.flow = flow
        self.pending = pending
        self.worker_id = worker_id
        self.version = version
        self.paused = False
        self.consig_session = "unknown"
        self.ai_enabled = False
        self.ai_model: str | None = None

    # ------------------------------------------------------------------ painel
    def handle_commands(self) -> list[str]:
        kinds = [c["kind"] for c in (self.api.rpc("robot_poll_commands") or [])]
        for kind in kinds:
            log.info("comando do painel", kind=kind)
            if kind == "pause":
                self.paused = True
            elif kind == "resume":
                self.paused = False
            elif kind == "open_consig":
                self.browser.open_consig()
            elif kind == "restart":
                self.report_state()
                raise RestartRequested()
        return kinds

    def report_state(self, step: str | None = None, job_id: str | None = None) -> None:
        out = self.api.rpc("robot_report_state", paused=self.paused, consig_session=self.consig_session,
                           current_step=step, current_job_id=job_id, version=self.version,
                           flow_ready=self.flow is not None) or {}
        self.ai_enabled = bool(out.get("ai_enabled"))
        self.ai_model = out.get("ai_model")

    # ------------------------------------------------------------------ pendentes
    def flush_pending(self) -> bool:
        """True quando não sobrou nada pendente. Erro temporário mantém o item para a próxima volta."""
        for item in self.pending.load():
            try:
                self.api.rpc("complete_job", job_id=item.job_id, adhesion_number=item.adhesion_number,
                             external_operation_id=item.external_operation_id, result_status=item.result_status)
            except ApiError as exc:
                if exc.is_transient or exc.is_auth_failure:
                    log.warning("resultado pendente não enviado", job_id=item.job_id, code=exc.code)
                    return False
                # Recusa definitiva (ex.: solicitação cancelada). O número já foi gravado por
                # report_captured_result e aparece no painel; manter o item travaria a fila para sempre.
                log.error("resultado pendente recusado pelo banco", job_id=item.job_id, code=exc.code)
            self.pending.remove(item.job_id)
        return True

    # ------------------------------------------------------------------ fila
    def tick(self) -> str:
        self.handle_commands()
        self.consig_session = self.browser.session_state()
        if not self.flush_pending():
            self.report_state("aguardando envio de resultado")
            return "pending"
        if self.paused:
            self.report_state()
            return "paused"
        if self.flow is None:
            self.report_state()
            return "no_flow"
        if self.consig_session != "authenticated":
            self.report_state()
            return "no_session"
        self.report_state()
        self.api.rpc("acknowledge_received_requests")
        job = self.api.rpc("claim_next_job", worker_id=self.worker_id, app_version=self.version)
        if not job:
            return "idle"
        return self.run_job(job)

    def run_job(self, job: dict[str, Any]) -> str:
        assert self.flow is not None
        job_id = job["job_id"]
        ctx = StepContext(job_id=job_id, request_id=job["request_id"], public_ref=job["public_ref"],
                          attempt=job["attempt"], payload=job.get("payload") or {}, fields=job.get("fields") or [])
        side_effect = False
        log.info("job reservado", job_id=job_id, request_id=ctx.request_id, attempt=ctx.attempt)
        try:
            self.api.rpc("mark_job_running", job_id=job_id)
            result: ProposalResult | None = None
            for step in self.flow.steps:
                self.api.rpc("heartbeat_job", job_id=job_id, step=step.name)
                self.report_state(step.name, job_id)
                if step.side_effect:
                    self.api.rpc("mark_side_effect_started", job_id=job_id, step=step.name)
                    side_effect = True
                result = step.run(self.browser.driver, ctx)
                if result is not None:
                    self._save_result(job_id, ctx.request_id, result)
                    break
            if result is None:
                raise UnexpectedScreen("fluxo terminou sem número de adesão")
        except Exception as exc:  # noqa: BLE001 — qualquer erro vira relatório ao banco
            return self._report_failure(job_id, exc, side_effect)
        finally:
            ctx.payload.clear()
        self.flush_pending()
        self.report_state()
        log.info("job concluído", job_id=job_id)
        return "completed"

    def _save_result(self, job_id: str, request_id: str, result: ProposalResult) -> None:
        self.pending.add(PendingResult(job_id=job_id, request_id=request_id,
                                       adhesion_number=result.adhesion_number, result_status=result.result_status,
                                       external_operation_id=result.external_operation_id))
        try:
            self.api.rpc("report_captured_result", job_id=job_id, adhesion_number=result.adhesion_number)
        except ApiError as exc:
            log.warning("número capturado não registrado; segue no arquivo de pendentes", job_id=job_id, code=exc.code)

    def _report_failure(self, job_id: str, exc: Exception, side_effect: bool) -> str:
        code = getattr(exc, "code", "ROBOT_ERROR") if not isinstance(exc, ApiError) else f"API_{exc.code}"[:64]
        message = log.safe_message(exc)
        log.error("job com erro", job_id=job_id, code=code, side_effect=side_effect, msg_redacted=message)
        try:
            if side_effect:
                self.api.rpc("escalate_job", job_id=job_id, reason_code=code, message=message)
                return "escalated"
            self.api.rpc("fail_job", job_id=job_id, error_code=code, error_message=message,
                         retryable=bool(getattr(exc, "retryable", True)))
            return "failed"
        except ApiError as report_exc:
            # Sem como avisar o banco: a reserva vence e recover_stale_jobs decide (com efeito → confirmação).
            log.error("falha ao reportar erro do job", job_id=job_id, code=report_exc.code)
            return "unreported"

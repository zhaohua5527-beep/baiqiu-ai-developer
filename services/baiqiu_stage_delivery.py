import hashlib
import json
import logging
import re
import time
import uuid


def parse_progress_payload(source):
    payload = source.lstrip()
    value, end = json.JSONDecoder().raw_decode(payload)
    if not isinstance(value, dict):
        raise ValueError("invalid_progress_json")
    tail = payload[end:]
    if value.get("schemaVersion") == 2:
        if ("message" in value or "summary" in value or not tail.startswith(("\n", "\r\n"))
                or value.get("type") not in ("stage_result", "cross")
                or not isinstance(value.get("segmentId"), str) or not value["segmentId"].strip()):
            raise ValueError("invalid_progress_body")
        body = tail[2:] if tail.startswith("\r\n") else tail[1:]
        if body.endswith("\r\n"):
            body = body[:-2]
        elif body.endswith("\n"):
            body = body[:-1]
        prose = re.sub(r"(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|`[^`\n]*`", "", body)
        if not body.strip() or re.search(r"</?(?:baiqiu-|[｜|]{1,2}DSML)", prose, re.I):
            raise ValueError("invalid_progress_body")
        return {**value, "message": body}
    if tail.strip():
        raise ValueError("invalid_progress_json")
    return value


def progress_blocks(content):
    if not isinstance(content, str):
        return []
    masked = re.sub(r"(?m)^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|\Z)",
                    lambda match: " " * len(match[0]), content)
    masked = re.sub(r"`[^`\n]*`", lambda match: " " * len(match[0]), masked)
    result = []
    cursor = 0
    for match in re.finditer(r"<baiqiu-progress>", masked, re.I):
        if match.start() < cursor:
            continue
        close = masked.lower().find("</baiqiu-progress>", match.end())
        tail = content[match.end():]
        try:
            header, header_end = json.JSONDecoder().raw_decode(tail.lstrip())
        except ValueError:
            header = None
        if isinstance(header, dict) and header.get("schemaVersion") == 2:
            ending = re.search(r"(?im)^[ \t]*</baiqiu-progress>[ \t]*(?=\r?$)", masked[match.end():])
            close = match.end() + ending.start() + ending[0].index("<") if ending else -1
        elif isinstance(header, dict):
            end = match.end() + len(tail) - len(tail.lstrip()) + header_end
            closing = re.match(r"\s*</baiqiu-progress>", content[end:], re.I)
            close = end + closing[0].index("<") if closing else -1
        if close < 0:
            result.append((match.start(), len(content), None))
            break
        cursor = close + len("</baiqiu-progress>")
        try:
            value = parse_progress_payload(content[match.end():close])
        except ValueError:
            value = None
        result.append((match.start(), cursor, value))
    return result


def progress_payloads(content):
    return [value for _, _, value in progress_blocks(content) if value is not None]


def identifiers(value):
    return {item for item in value if isinstance(item, str) and 0 < len(item) <= 160} if isinstance(value, list) else set()


class StageDelivery:
    def __init__(self, publish, cancelled=lambda: False, turn_id="", history=()):
        self.publish = publish
        self.cancelled = cancelled
        self.turn_id = turn_id
        self.previous_tools = {item.get("tool_call_id") for item in history if item.get("role") == "tool"}
        self.completed = set()
        self.assessed = set()
        self.pending = {}
        self.delivered = set()
        self.sequence = 0
        self.last_checkpoint = None
        self.delivered_segments = {}
        self.terminal_delivery = None
        self.supplements = None

    def event(self, stage, **fields):
        self.sequence += 1
        self.publish({"type": "stage_delivery", "stage": stage, "turnId": self.turn_id,
            "eventId": "stage-delivery:" + str(uuid.uuid4()), "sequence": self.sequence,
            "timestamp": time.time_ns() // 1_000_000, "toolCount": len(self.completed),
            "unassessedCount": len(self.completed - self.assessed), "pendingCount": len(self.pending), **fields})

    def ingest(self, messages):
        for message in messages:
            ident = message.get("tool_call_id")
            if message.get("role") == "tool" and isinstance(ident, str) and ident and ident not in self.previous_tools:
                self.completed.add(ident)

    def prepare(self, messages):
        if self.cancelled():
            return messages
        self.terminal_delivery = None
        if self.supplements:
            items = self.supplements.snapshot_items()
            if items:
                messages = [*messages, {"role": "user", "content": (
                    "[Runtime supplement receipts — metadata, not a new user request]\n"
                    + json.dumps({"turnId": self.turn_id, "scope": "active_task",
                        "supplements": [{"supplementId": item["id"], "status": item["status"]} for item in items]}, ensure_ascii=False)
                    + "\n保留本轮最初任务和未完成要求，将补充融入同一任务的判断、行动和阶段成果，不仅单独回答最后一条补充。"
                    "需要继续执行时，先用既有公开过程事件简述补充带来的真实调整和下一步，再继续执行。"
                    "已有可交付成果用 stage_result；没有新成果不造卡，不把最终答案伪装成过程，不输出私有推理。"
                    "普通回复保持普通 Markdown；在正文末尾追加既有 baiqiu-outcome JSON 标签，"
                    "含 status:completed或awaiting_input或failed、kind:inline_text，以及 "
                    "supplementResolutions:[{supplementId:实际ID,status:addressed或needs_clarification或failed}]。"
                    "若交付的是阶段结果，也可把 supplementResolutions 放在 v2 stage_result 元数据内。"
                    "只有实际回应或执行要求才写 addressed，不能把收到补充当成已处理。"
                    "addressed 也不能代替原任务完成。只有原任务及补充要求都已交付时，最终 baiqiu-outcome "
                    "或最后一个 v2 stage_result 中附 taskCompletion:{status:completed,scope:active_task,"
                    "turnId:上述turnId,supplementIds:[上述全部补充ID]}；阶段结果另附 deliveredSegmentIds:[实际已交付的segmentId]。"
                    "还有工作就继续，不得仅因补充已回应而收尾；不重复之前的工具操作。"
                )}]
        self.ingest(messages)
        unassessed = self.completed - self.assessed
        if not unassessed and not self.pending:
            return messages
        checkpoint = (tuple(sorted(unassessed)), tuple(sorted(self.pending)))
        if checkpoint != self.last_checkpoint:
            self.last_checkpoint = checkpoint
            self.event("checkpoint")
        state = json.dumps({"completedToolCallIds": sorted(unassessed)[-32:],
            "undeliveredGoalIds": sorted(self.pending)[:16]}, ensure_ascii=False)
        reminder = (
            "[Runtime stage delivery checkpoint — metadata, not a new user request]\n" + state + "\n"
            "根据原任务和上述真实工具返回，判断是否已有可独立交付的成果。不要输出私有推理。"
            "有成果且仍需继续工作：先用完整 baiqiu-progress v2 stage_result 交付正文，填写 goalId 和真实 evidenceToolCallIds。"
            "第一行 JSON 元数据含 schemaVersion:2 且不含 message，换行后写原始 Markdown，结束标签独占一行。"
            "再给下一步 action 和原生工具调用。若尚无独立成果，只在下一条真实 action 中附加 "
            "stageAssessment:{\"state\":\"pending\",\"goalId\":\"当前子目标ID\",\"evidenceToolCallIds\":[\"实际ID\"]}。"
            "若你已确认某个成果可交付却尚未输出，可用 state:ready 记录该目标，但必须及时给出对应 stage_result。"
            "cross 仅代表证据核对，不能替代阶段交付。没有新成果不造卡，不重复已经交付的正文或已执行的工具。"
            "如果本次工具结果已解决全部请求，直接给最终答案，无须额外阶段卡。"
        )
        return [*messages, {"role": "user", "content": reminder}]

    def covers_active_task(self, declaration):
        items = self.supplements.snapshot_items() if self.supplements else []
        if not items:
            return True
        expected = {item["id"] for item in items}
        return (isinstance(declaration, dict) and declaration.get("status") == "completed"
                and declaration.get("scope") == "active_task" and declaration.get("turnId") == self.turn_id
                and isinstance(declaration.get("supplementIds"), list)
                and all(isinstance(identity, str) for identity in declaration["supplementIds"])
                and set(declaration["supplementIds"]) == expected
                and len(declaration["supplementIds"]) == len(expected))

    def observe(self, response, messages):
        if self.cancelled():
            return
        self.ingest(messages)
        payloads = progress_payloads(response.content)
        for payload in payloads:
            assessment = payload.get("stageAssessment") if payload.get("type") == "action" else None
            if not isinstance(assessment, dict):
                continue
            evidence = identifiers(assessment.get("evidenceToolCallIds"))
            goal = assessment.get("goalId")
            state = assessment.get("state")
            if state not in ("ready", "pending") or not isinstance(goal, str) or not 0 < len(goal) <= 160 or not evidence or not evidence <= self.completed:
                self.event("invalid_assessment")
                continue
            self.assessed.update(evidence)
            if state == "ready" and goal not in self.delivered:
                self.pending[goal] = evidence
            self.event("ready" if state == "ready" else "pending", goalId=goal, evidenceToolCallIds=sorted(evidence))
        for payload in payloads:
            if payload.get("type") != "stage_result" or not isinstance(payload.get("message"), str) or not payload["message"].strip():
                continue
            evidence = identifiers(payload.get("evidenceToolCallIds"))
            verified = bool(evidence) and evidence <= self.completed
            goal = payload.get("goalId")
            if verified:
                self.assessed.update(evidence)
                if isinstance(goal, str) and 0 < len(goal) <= 160:
                    self.pending.pop(goal, None)
                    self.delivered.add(goal)
            self.event("authored", segmentId=str(payload.get("segmentId") or "")[:160],
                goalId=goal[:160] if isinstance(goal, str) else "", evidenceToolCallIds=sorted(evidence),
                evidenceResolved=verified, contentChars=len(payload["message"].encode("utf-16-le", errors="surrogatepass")) // 2)
            segment_id = payload.get("segmentId")
            if isinstance(segment_id, str) and 0 < len(segment_id) <= 64:
                self.delivered_segments[segment_id] = dict(target="structured", segmentId=segment_id,
                    sha256=hashlib.sha256(payload["message"].replace("\r\n", "\n").strip().encode()).hexdigest())
                if self.supplements:
                    self.supplements.resolve(payload.get("supplementResolutions"), segment_id)
        for payload in payloads:
            declaration = payload.get("taskCompletion")
            if not isinstance(declaration, dict) or declaration.get("status") != "completed" or response.tool_calls:
                continue
            references = declaration.get("deliveredSegmentIds")
            if (not isinstance(references, list) or not references or len(references) > 100
                    or any(not isinstance(identity, str) or identity not in self.delivered_segments for identity in references)):
                continue
            supplement_items = self.supplements.snapshot_items() if self.supplements else []
            pending_inputs = any(item["status"] != "addressed" for item in supplement_items)
            if self.pending or pending_inputs or not self.covers_active_task(declaration):
                continue
            self.terminal_delivery = dict(version=1, status="completed", scope="active_task",
                outputs=[dict(self.delivered_segments[identity]) for identity in dict.fromkeys(references)],
                addressedSupplementIds=[item["id"] for item in supplement_items])
        visible = response.content or ""
        for start, end, _ in reversed(progress_blocks(visible)):
            visible = visible[:start] + visible[end:]
        ending = re.search(r"<baiqiu-outcome>([^<]*)</baiqiu-outcome>\s*$", visible, re.I)
        if ending and not response.tool_calls:
            self.terminal_delivery = None
            try:
                declaration = json.loads(ending[1])
            except ValueError:
                declaration = None
            body = visible[:ending.start()].replace("\r\n", "\n").strip()
            if isinstance(declaration, dict) and body:
                digest = hashlib.sha256(body.encode()).hexdigest()
                reference = dict(target="answer", segmentId="answer:" + digest, sha256=digest,
                    contentChars=len(body.encode("utf-16-le", errors="surrogatepass")) // 2)
                if self.supplements:
                    self.supplements.resolve(declaration.get("supplementResolutions"), reference["segmentId"])
                if self.supplements:
                    with self.supplements.lock:
                        statuses = [item["status"] for item in self.supplements.items.values()]
                else:
                    statuses = []
                status = declaration.get("status")
                resolved = all(item == "addressed" for item in statuses) if status == "completed" else (
                    status == "awaiting_input" and "needs_clarification" in statuses
                    and all(item in ("addressed", "needs_clarification") for item in statuses))
                if resolved and not self.pending and (status != "completed" or self.covers_active_task(declaration.get("taskCompletion"))):
                    self.terminal_delivery = dict(version=1, status=status, outputs=[reference], scope="active_task",
                        addressedSupplementIds=[item["id"] for item in self.supplements.snapshot_items()
                                                if item["status"] == "addressed"] if self.supplements else [])
        if self.pending:
            self.event("delivery_missing")
        elif response.tool_calls and self.completed - self.assessed:
            self.event("assessment_missing")
        elif not response.tool_calls and response.content:
            self.event("final")


def bind_stage_delivery(agent, conn, session_id, loop, cancelled, turn_id="", history=()):
    import acp
    from acp_adapter.events import _send_update

    def publish(diagnostic):
        update = acp.update_agent_message_text("")
        update.field_meta = {"baiqiu_diagnostic": diagnostic}
        _send_update(conn, session_id, loop, update)

    delivery = StageDelivery(publish, cancelled, turn_id, history)
    build = agent._build_api_kwargs
    had_build = "_build_api_kwargs" in agent.__dict__

    def build_request(messages, *args, **kwargs):
        try:
            prepared = delivery.prepare(messages)
        except Exception:
            logging.getLogger(__name__).exception("Stage delivery checkpoint unavailable; keeping original request")
            prepared = messages
        return build(prepared, *args, **kwargs)

    agent._build_api_kwargs = build_request
    agent._baiqiu_stage_delivery = delivery

    def restore():
        if agent._build_api_kwargs is build_request:
            if had_build:
                agent._build_api_kwargs = build
            else:
                del agent._build_api_kwargs
        if getattr(agent, "_baiqiu_stage_delivery", None) is delivery:
            del agent._baiqiu_stage_delivery

    return delivery, restore

#!/usr/bin/env python3
import base64
import cgi
import hashlib
import hmac
import json
import mimetypes
import os
import html
import secrets
import shutil
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(os.environ.get("BAIQIU_UPDATE_ROOT", "/opt/baiqiu-update")).resolve()
RELEASES = ROOT / "releases"
ASSETS = ROOT / "assets"
MANIFEST = ROOT / "updates.json"
ADMIN_CONFIG = ROOT / "admin.json"
LICENSES = ROOT / "licenses.json"
ACCOUNTING = ROOT / "accounting.json"
PORT = int(os.environ.get("BAIQIU_UPDATE_PORT", "18790"))
HOST = os.environ.get("BAIQIU_UPDATE_HOST", "127.0.0.1").strip() or "127.0.0.1"
SESSION_COOKIE = "baiqiu_admin"
SESSION_SECONDS = 12 * 60 * 60
MAX_UPLOAD_BYTES = int(os.environ.get("BAIQIU_MAX_UPLOAD_BYTES", str(800 * 1024 * 1024)))
ONLINE_CLIENTS = {}
ADMIN_SECRET = os.environ.get("BAIQIU_LICENSE_SECRET", "BaiqiuAICommercialServerSecretChangeMe")


def read_json(path, fallback):
    try:
        return json.loads(path.read_text("utf-8-sig"))
    except Exception:
        return fallback


def write_json(path, payload):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


def b64e(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64d(text):
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode((text + padding).encode("ascii"))


def hash_password(password, salt=None, iterations=220000):
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {
        "algorithm": "pbkdf2_sha256",
        "iterations": iterations,
        "salt": b64e(salt),
        "hash": b64e(digest),
    }


def ensure_admin_config():
    if ADMIN_CONFIG.exists():
        config = read_json(ADMIN_CONFIG, {})
        if config.get("password") and config.get("sessionSecret"):
            config.setdefault("programmers", [])
            return config
    password = os.environ.get("BAIQIU_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
    config = {
        "username": "admin",
        "password": hash_password(password),
        "sessionSecret": b64e(os.urandom(32)),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "programmers": [],
    }
    write_json(ADMIN_CONFIG, config)
    try:
        os.chmod(ADMIN_CONFIG, 0o600)
    except Exception:
        pass
    if not os.environ.get("BAIQIU_ADMIN_PASSWORD"):
        print("[BaiqiuUpdateServer] admin password generated; reset /opt/baiqiu-update/admin.json if needed.", flush=True)
    return config


def verify_admin_password(username, password):
    config = ensure_admin_config()
    if username != config.get("username", "admin"):
        for user in config.get("programmers", []):
            if user.get("username") != username or user.get("active") is False:
                continue
            stored = user.get("password") or {}
            try:
                salt = b64d(stored["salt"])
                expected = b64d(stored["hash"])
                iterations = int(stored.get("iterations", 220000))
                digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
                if hmac.compare_digest(digest, expected):
                    return True
            except Exception:
                continue
        return False
    stored = config.get("password") or {}
    try:
        salt = b64d(stored["salt"])
        expected = b64d(stored["hash"])
        iterations = int(stored.get("iterations", 220000))
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def authenticate_admin_login(username, password):
    config = ensure_admin_config()
    if verify_admin_password(username, password):
        if username == config.get("username", "admin"):
            return {"role": "admin", "username": username}
        for user in config.get("programmers", []):
            if user.get("username") == username and user.get("active") is not False:
                return {"role": "programmer", "username": username}
    return None


def create_programmer_account(username, password, note=""):
    username = str(username or "").strip()
    password = str(password or "").strip()
    if not username or not password:
        raise ValueError("请填写程序员账号和密码")
    if username == "admin":
        raise ValueError("不能使用 admin 作为程序员账号")
    config = ensure_admin_config()
    for user in config.setdefault("programmers", []):
        if user.get("username") == username:
            user["password"] = hash_password(password)
            user["active"] = True
            user["note"] = str(note or "").strip()
            user["updatedAt"] = now_iso()
            write_json(ADMIN_CONFIG, config)
            return user
    user = {
        "id": "PG" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + secrets.token_hex(3).upper(),
        "username": username,
        "password": hash_password(password),
        "active": True,
        "role": "programmer",
        "permission": "version_update_only",
        "note": str(note or "").strip(),
        "createdAt": now_iso(),
    }
    config.setdefault("programmers", []).append(user)
    write_json(ADMIN_CONFIG, config)
    return user


def revoke_programmer_account(username):
    username = str(username or "").strip()
    config = ensure_admin_config()
    for user in config.setdefault("programmers", []):
        if user.get("username") == username:
            user["active"] = False
            user["revokedAt"] = now_iso()
            write_json(ADMIN_CONFIG, config)
            return user
    raise ValueError("程序员账号不存在")


def session_signature(secret, timestamp):
    return hmac.new(secret, timestamp.encode("ascii"), hashlib.sha256).hexdigest()


def make_session_cookie():
    config = ensure_admin_config()
    role = "admin"
    secret = b64d(config["sessionSecret"])
    timestamp = str(int(time.time()))
    sig = session_signature(secret, f"{role}:{timestamp}:admin")
    value = f"{role}:{timestamp}:admin:{sig}"
    return f"{SESSION_COOKIE}={value}; Path=/admin; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Lax"


def clear_session_cookie():
    return f"{SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax"


def parse_cookie(header):
    result = {}
    for part in (header or "").split(";"):
        if "=" in part:
            key, value = part.strip().split("=", 1)
            result[key] = value
    return result


def is_admin_authenticated(handler):
    token = parse_cookie(handler.headers.get("Cookie")).get(SESSION_COOKIE, "")
    try:
        role, timestamp, username, sig = token.split(":", 3)
        issued_at = int(timestamp)
    except Exception:
        return False
    if issued_at < int(time.time()) - SESSION_SECONDS or issued_at > int(time.time()) + 60:
        return False
    try:
        secret = b64d(ensure_admin_config()["sessionSecret"])
        expected = session_signature(secret, f"{role}:{timestamp}:{username}")
        return hmac.compare_digest(sig, expected)
    except Exception:
        return False


def make_role_session_cookie(role, username):
    config = ensure_admin_config()
    secret = b64d(config["sessionSecret"])
    timestamp = str(int(time.time()))
    sig = session_signature(secret, f"{role}:{timestamp}:{username}")
    value = f"{role}:{timestamp}:{username}:{sig}"
    return f"{SESSION_COOKIE}={value}; Path=/admin; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Lax"


def current_auth(handler):
    token = parse_cookie(handler.headers.get("Cookie")).get(SESSION_COOKIE, "")
    try:
        role, timestamp, username, sig = token.split(":", 3)
        issued_at = int(timestamp)
    except Exception:
        return None
    if issued_at < int(time.time()) - SESSION_SECONDS or issued_at > int(time.time()) + 60:
        return None
    try:
        secret = b64d(ensure_admin_config()["sessionSecret"])
        expected = session_signature(secret, f"{role}:{timestamp}:{username}")
        if not hmac.compare_digest(sig, expected):
            return None
        return {"role": role, "username": username}
    except Exception:
        return None


def require_admin(handler):
    auth = current_auth(handler)
    return bool(auth and auth.get("role") == "admin")


def redirect(handler, location, cookie=None):
    handler.send_response(303)
    handler.send_header("Location", location)
    if cookie:
        handler.send_header("Set-Cookie", cookie)
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()


def write_json_response(handler, payload, status=200):
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def version_key(value):
    base = str(value or "0.0.0").strip().lstrip("vV").split("+", 1)[0].split("-", 1)[0]
    parts = []
    for part in base.split("."):
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits or "0"))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def sha256_file(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def latest_release(channel="stable"):
    manifest = read_json(MANIFEST, {"channels": {"stable": []}})
    releases = manifest.get("channels", {}).get(channel) or manifest.get("channels", {}).get("stable") or []
    releases = [item for item in releases if isinstance(item, dict) and item.get("version")]
    releases.sort(key=lambda item: version_key(item.get("version")), reverse=True)
    return releases[0] if releases else None


def default_license_store():
    return {
        "plans": {
            "weekly": {
                "name": "周卡",
                "durationDays": 7,
                "basePrice": 19.9,
                "firstPrice": 9.9,
                "description": "适合短期体验和临时使用。",
            },
            "monthly": {
                "name": "月卡",
                "durationDays": 31,
                "basePrice": 49.9,
                "firstPrice": 19.9,
                "description": "适合短期使用和轻量客户，首次付费享受折扣价。",
            },
            "six_months": {
                "name": "6个月",
                "durationDays": 186,
                "basePrice": 99,
                "firstPrice": 88,
                "description": "适合稳定使用的客户，半年授权更省心。",
            },
            "redeem_lifetime": {
                "name": "兑换码",
                "durationDays": 0,
                "basePrice": 0,
                "firstPrice": 0,
                "description": "由管理者发放，一般为永久有效。",
            },
        },
        "codes": [],
        "orders": [],
        "redemptions": [],
        "blacklist": [],
    }


def read_license_store():
    data = read_json(LICENSES, default_license_store())
    defaults = default_license_store()
    data.setdefault("plans", defaults["plans"])
    for key, value in defaults["plans"].items():
        data["plans"].setdefault(key, value)
    data["plans"].setdefault("yearly", {
        "name": "12个月",
        "durationDays": 372,
        "basePrice": 180,
        "firstPrice": 168,
        "description": "适合重度使用客户，12个月会员。",
    })
    data.setdefault("codes", [])
    data.setdefault("orders", [])
    data.setdefault("redemptions", [])
    data.setdefault("blacklist", [])
    return data


def write_license_store(data):
    write_json(LICENSES, data)


def normalize_identity(value):
    return str(value or "").strip().lower()


def blacklist_duration_info(duration):
    duration = str(duration or "permanent").strip()
    mapping = {
        "3d": ("3?", 3),
        "7d": ("7?", 7),
        "1m": ("1??", 31),
        "permanent": ("??", 0),
    }
    label, days = mapping.get(duration, mapping["permanent"])
    expires_at = ""
    if days > 0:
        expires_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + days * 86400))
    return duration, label, expires_at


def blacklist_match(data, ip="", customer="", phone="", device_id=""):
    ip_n = normalize_identity(ip)
    customer_n = normalize_identity(customer)
    phone_n = normalize_identity(phone)
    device_n = normalize_identity(device_id)
    for item in data.get("blacklist", []):
        if item.get("status", "active") != "active":
            continue
        expires_at = str(item.get("expiresAt", "") or "")
        if expires_at:
            try:
                if time.mktime(time.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ")) <= time.time():
                    continue
            except Exception:
                pass
        if ip_n and normalize_identity(item.get("ip")) == ip_n:
            return item
        if customer_n and normalize_identity(item.get("name")) == customer_n:
            return item
        if phone_n and normalize_identity(item.get("phone")) == phone_n:
            return item
        if device_n and normalize_identity(item.get("deviceId")) == device_n:
            return item
    return None


def add_to_blacklist(ip="", name="", phone="", device_id="", reason="", duration="permanent"):
    data = read_license_store()
    duration, duration_label, expires_at = blacklist_duration_info(duration)
    item = {
        "id": "BL" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + secrets.token_hex(3).upper(),
        "ip": str(ip or "").strip(),
        "name": str(name or "").strip(),
        "phone": str(phone or "").strip(),
        "deviceId": str(device_id or "").strip(),
        "reason": str(reason or "?????????????").strip(),
        "duration": duration,
        "durationLabel": duration_label,
        "expiresAt": expires_at,
        "status": "active",
        "createdAt": now_iso(),
    }
    data.setdefault("blacklist", []).append(item)
    for order in data.get("orders", []):
        customer = normalize_identity(order.get("customer"))
        device = normalize_identity(order.get("deviceId"))
        if (item["name"] and customer == normalize_identity(item["name"])) or (item["deviceId"] and device == normalize_identity(item["deviceId"])):
            order["status"] = "banned"
            order["bannedAt"] = now_iso()
            order["banReason"] = item["reason"]
            order["expiresAt"] = now_iso()
    write_license_store(data)
    if item["ip"]:
        ONLINE_CLIENTS.pop(item["ip"], None)
    return item


def release_blacklist_item(item_id):
    data = read_license_store()
    target = str(item_id or "").strip()
    for item in data.get("blacklist", []):
        if str(item.get("id", "")) == target:
            item["status"] = "released"
            item["releasedAt"] = now_iso()
            write_license_store(data)
            return item
    raise ValueError("????????")


def force_offline(ip="", phone="", duration="permanent"):
    ip = str(ip or "").strip()
    phone = str(phone or "").strip()
    if not ip and not phone:
        raise ValueError("??? IP ?????")
    existed = ip in ONLINE_CLIENTS
    if ip:
        ONLINE_CLIENTS.pop(ip, None)
    item = add_to_blacklist(ip=ip, phone=phone, reason="????", duration=duration)
    return existed, item
def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def make_redeem_code(prefix="BQ"):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    parts = []
    for _ in range(3):
        parts.append("".join(secrets.choice(alphabet) for _ in range(4)))
    return f"{prefix}-" + "-".join(parts)


def generate_redeem_codes(plan="redeem_lifetime", count=1, note=""):
    count = max(1, min(int(count or 1), 200))
    data = read_license_store()
    existing = {str(item.get("code", "")).upper() for item in data.get("codes", [])}
    created = []
    for _ in range(count):
        code = make_redeem_code()
        while code.upper() in existing:
            code = make_redeem_code()
        existing.add(code.upper())
        item = {
            "code": code,
            "plan": plan,
            "durationDays": int(data.get("plans", {}).get(plan, {}).get("durationDays", 0)),
            "status": "active",
            "note": note,
            "createdAt": now_iso(),
            "redeemedAt": "",
            "redeemedBy": "",
        }
        data["codes"].append(item)
        created.append(item)
    write_license_store(data)
    return created


def redeem_code(code, customer="", phone=""):
    normalized = str(code or "").strip().upper()
    customer = str(customer or "").strip()
    phone = str(phone or "").strip()
    if not normalized:
        raise ValueError("请输入兑换码")
    data = read_license_store()
    if blacklist_match(data, customer=customer, phone=phone):
        raise ValueError("该账号已进入白球小黑屋，禁止兑换和使用")
    for item in data.get("codes", []):
        if str(item.get("code", "")).upper() != normalized:
            continue
        if item.get("status") != "active":
            raise ValueError("这个兑换码不可用")
        if item.get("redeemedAt"):
            raise ValueError("这个兑换码已经被兑换")
        plan_key = item.get("plan") or "redeem_lifetime"
        plan = data.get("plans", {}).get(plan_key, {})
        duration_days = int(item.get("durationDays", plan.get("durationDays", 0)) or 0)
        expires_at = ""
        if duration_days > 0:
            expires_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + duration_days * 86400))
        item["redeemedAt"] = now_iso()
        item["redeemedBy"] = customer
        item["redeemedName"] = customer
        item["redeemedPhone"] = phone
        redemption = {
            "code": item.get("code"),
            "plan": plan_key,
            "planName": plan.get("name", "兑换码"),
            "customer": customer,
            "name": customer,
            "phone": phone,
            "redeemedAt": item["redeemedAt"],
            "expiresAt": expires_at,
            "lifetime": duration_days <= 0,
        }
        data.setdefault("redemptions", []).append(redemption)
        write_license_store(data)
        return redemption
    raise ValueError("兑换码不存在")

    raise ValueError("??????")


def recycle_redeem_code(code):
    normalized = str(code or "").strip().upper()
    if not normalized:
        raise ValueError("?????")
    data = read_license_store()
    for item in data.get("codes", []):
        if str(item.get("code", "")).upper() != normalized:
            continue
        item["redeemedAt"] = ""
        item["redeemedBy"] = ""
        item["redeemedName"] = ""
        item["redeemedPhone"] = ""
        item["status"] = "recycled"
        item["recycledAt"] = now_iso()
        data["redemptions"] = [r for r in data.get("redemptions", []) if str(r.get("code", "")).upper() != normalized]
        write_license_store(data)
        return item
    raise ValueError("??????")


def create_order(plan_key, customer=""):
    data = read_license_store()
    plans = data.get("plans", {})
    if blacklist_match(data, customer=customer):
        raise ValueError("该账号已进入白球小黑屋，禁止购买")
    if plan_key not in ("monthly", "six_months"):
        raise ValueError("请选择正确的套餐")
    plan = plans[plan_key]
    order = {
        "orderId": "BQ" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + secrets.token_hex(3).upper(),
        "plan": plan_key,
        "planName": plan.get("name"),
        "basePrice": plan.get("basePrice"),
        "firstPrice": plan.get("firstPrice"),
        "customer": str(customer or "").strip(),
        "status": "pending_payment",
        "createdAt": now_iso(),
    }
    data.setdefault("orders", []).append(order)
    write_license_store(data)
    return order


def create_paid_order(plan_key, customer="", device_id="", payment_method="wechat", phone=""):
    data = read_license_store()
    plans = data.get("plans", {})
    if blacklist_match(data, customer=customer, device_id=device_id):
        raise ValueError("该账号已进入白球小黑屋，禁止购买")
    if plan_key not in ("monthly", "six_months", "yearly"):
        raise ValueError("请选择正确的会员套餐")
    plan = plans[plan_key]
    order = {
        "orderId": "BQ" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + secrets.token_hex(3).upper(),
        "plan": plan_key,
        "planName": plan.get("name"),
        "durationDays": int(plan.get("durationDays", 0) or 0),
        "basePrice": plan.get("basePrice"),
        "firstPrice": plan.get("firstPrice"),
        "customer": str(customer or "").strip(),
        "phone": str(phone or "").strip(),
        "deviceId": str(device_id or "").strip(),
        "paymentMethod": str(payment_method or "wechat").strip(),
        "status": "pending_review",
        "createdAt": now_iso(),
        "paidAt": "",
        "approvedAt": "",
        "licenseCode": "",
        "expiresAt": "",
    }
    data.setdefault("orders", []).append(order)
    write_license_store(data)
    return order


def _paid_license_signature(code, device_id, expires_at):
    data = f"{code}{device_id}{expires_at}{ADMIN_SECRET}"
    return hmac.new(
        ADMIN_SECRET.encode("utf-8"),
        data.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def approve_paid_order(order_id):
    data = read_license_store()
    orders = data.setdefault("orders", [])
    for order in orders:
        if str(order.get("orderId", "")) != str(order_id or ""):
            continue
        if order.get("status") == "approved" and order.get("licenseCode"):
            write_license_store(data)
            return order
        plan_key = order.get("plan") or "monthly"
        plan = data.get("plans", {}).get(plan_key, {})
        duration_days = int(order.get("durationDays", plan.get("durationDays", 31)) or 31)
        expires_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + duration_days * 86400))
        code = order.get("licenseCode") or ("PAID-" + secrets.token_hex(8).upper())
        order["status"] = "approved"
        order["paidAt"] = order.get("paidAt") or now_iso()
        order["approvedAt"] = now_iso()
        order["licenseCode"] = code
        order["expiresAt"] = expires_at
        order["serverSignature"] = _paid_license_signature(code, order.get("deviceId", ""), expires_at)
        write_license_store(data)
        try:
            add_accounting_entry(
                "income",
                order.get("firstPrice") or order.get("basePrice") or 0,
                "授权收入",
                "微信" if order.get("paymentMethod") == "wechat" else "支付宝",
                f"会员订单 {order.get('orderId')} {order.get('planName')}",
                "",
                order.get("orderId"),
            )
        except Exception:
            pass
        return order
    raise ValueError("订单不存在")


def paid_order_status(order_id, device_id=""):
    data = read_license_store()
    for order in data.get("orders", []):
        if str(order.get("orderId", "")) != str(order_id or ""):
            continue
        if device_id and order.get("deviceId") and str(order.get("deviceId")) != str(device_id):
            raise ValueError("订单设备不匹配")
        if order.get("status") == "banned" or blacklist_match(data, customer=order.get("customer"), device_id=order.get("deviceId") or device_id):
            raise ValueError("账号权限已被收回，并已被白球永久封号")
        payload = {
            "orderId": order.get("orderId"),
            "status": order.get("status"),
            "plan": order.get("plan"),
            "planName": order.get("planName"),
            "amount": order.get("firstPrice"),
            "expiresAt": order.get("expiresAt", ""),
            "message": "待管理员审核付款" if order.get("status") != "approved" else "付款已确认，会员已发放",
        }
        if order.get("status") == "approved":
            payload["license"] = {
                "code": order.get("licenseCode"),
                "expiresAt": order.get("expiresAt"),
                "signature": order.get("serverSignature"),
                "lifetime": False,
            }
        return payload
    raise ValueError("订单不存在")


def default_accounting_store():
    return {
        "entries": [],
        "categories": ["授权收入", "服务器费用", "推广费用", "人工成本", "其他"],
        "paymentMethods": ["微信", "支付宝", "银行卡", "现金", "其他"],
    }


def read_accounting_store():
    data = read_json(ACCOUNTING, default_accounting_store())
    defaults = default_accounting_store()
    data.setdefault("entries", [])
    data.setdefault("categories", defaults["categories"])
    data.setdefault("paymentMethods", defaults["paymentMethods"])
    return data


def write_accounting_store(data):
    write_json(ACCOUNTING, data)


def parse_amount(value):
    text = str(value or "").strip().replace(",", "")
    if not text:
        raise ValueError("请填写金额")
    try:
        amount = round(float(text), 2)
    except Exception:
        raise ValueError("金额格式不正确")
    if amount <= 0:
        raise ValueError("金额必须大于 0")
    return amount


def add_accounting_entry(kind, amount, category="", method="", note="", entry_date="", related=""):
    kind = str(kind or "").strip()
    if kind not in ("income", "expense"):
        raise ValueError("请选择收入或支出")
    data = read_accounting_store()
    entry = {
        "id": "AC" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + secrets.token_hex(3).upper(),
        "kind": kind,
        "amount": parse_amount(amount),
        "category": str(category or "其他").strip() or "其他",
        "method": str(method or "其他").strip() or "其他",
        "note": str(note or "").strip(),
        "date": str(entry_date or time.strftime("%Y-%m-%d", time.localtime())).strip(),
        "related": str(related or "").strip(),
        "createdAt": now_iso(),
    }
    data.setdefault("entries", []).append(entry)
    write_accounting_store(data)
    return entry


def accounting_summary(entries):
    income = sum(float(item.get("amount", 0) or 0) for item in entries if item.get("kind") == "income")
    expense = sum(float(item.get("amount", 0) or 0) for item in entries if item.get("kind") == "expense")
    return {
        "income": round(income, 2),
        "expense": round(expense, 2),
        "balance": round(income - expense, 2),
    }


def track_online_client(handler):
    ip = handler.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip() or handler.client_address[0]
    ua = handler.headers.get("User-Agent", "")
    query = parse_qs(urlparse(getattr(handler, "path", "")).query)
    customer_name = handler.headers.get("X-Baiqiu-Customer") or (query.get("customer") or query.get("name") or [""])[0]
    phone = handler.headers.get("X-Baiqiu-Phone") or (query.get("phone") or [""])[0]
    device_id = handler.headers.get("X-Baiqiu-Device") or (query.get("deviceId") or [""])[0]
    ONLINE_CLIENTS[ip] = {"lastSeen": time.time(), "userAgent": ua[:160], "customerName": str(customer_name or "").strip(), "phone": str(phone or "").strip(), "deviceId": str(device_id or "").strip()}
    cutoff = time.time() - 5 * 60
    for key, value in list(ONLINE_CLIENTS.items()):
        if float(value.get("lastSeen", 0)) < cutoff:
            ONLINE_CLIENTS.pop(key, None)


def developer_status_payload():
    license_store = read_license_store()
    orders = license_store.get("orders", [])
    codes = license_store.get("codes", [])
    pending_orders = [item for item in orders if item.get("status") == "pending_payment"]
    redeemed_without_customer = [item for item in codes if item.get("redeemedAt") and not item.get("redeemedBy")]
    duplicate_codes = []
    seen = set()
    for item in codes:
        code = str(item.get("code", "")).upper()
        if not code:
            continue
        if code in seen:
            duplicate_codes.append(code)
        seen.add(code)
    issues = []
    if pending_orders:
        issues.append({"type": "pending_payment", "count": len(pending_orders), "message": f"{len(pending_orders)} 个订单待支付/待确认"})
    if redeemed_without_customer:
        issues.append({"type": "missing_customer", "count": len(redeemed_without_customer), "message": f"{len(redeemed_without_customer)} 个已兑换账号缺少客户标识"})
    if duplicate_codes:
        issues.append({"type": "duplicate_code", "count": len(duplicate_codes), "message": f"{len(duplicate_codes)} 个兑换码重复"})
    return {
        "ok": True,
        "onlineUsers": len(ONLINE_CLIENTS),
        "abnormalAccounts": sum(item["count"] for item in issues),
        "issues": issues,
        "checkedAt": now_iso(),
    }


def public_origin(handler):
    proto = handler.headers.get("X-Forwarded-Proto") or "http"
    host = handler.headers.get("X-Forwarded-Host") or handler.headers.get("Host") or f"127.0.0.1:{PORT}"
    return f"{proto}://{host}".rstrip("/")


def latest_payload(handler, channel="stable"):
    origin = public_origin(handler)
    release = latest_release(channel)
    if not release:
        return {
            "name": "白球 AI",
            "version": "0.0.0",
            "latestVersion": "0.0.0",
            "downloadUrl": "",
            "packageUrl": "",
            "installerUrl": "",
            "forceUpdate": False,
            "changelog": "暂无更新",
            "notes": ["暂无更新"],
        }
    version = str(release.get("version"))
    file_path = release_file(release)
    checksum = release.get("sha256") or (sha256_file(file_path) if file_path and file_path.exists() else "")
    download_url = f"{origin}/baiqiu-{quote(version)}.zip"
    payload = {
        "name": "白球 AI",
        "version": version,
        "latestVersion": version,
        "downloadUrl": download_url,
        "packageUrl": download_url,
        "sha256": checksum,
        "checksum": checksum,
        "forceUpdate": bool(release.get("forceUpdate", True)),
        "changelog": release.get("notes") or release.get("changelog") or "白球 AI 更新",
        "releaseNotes": release.get("notes") or release.get("changelog") or "",
        "notes": [release.get("notes") or release.get("changelog") or "白球 AI 更新"],
        "zipSize": file_path.stat().st_size if file_path and file_path.exists() else 0,
    }
    if release.get("installerFile"):
        installer_path = (RELEASES / release["installerFile"]).resolve()
        payload["installerUrl"] = f"{origin}/download/baiqiu-{quote(version)}-setup.exe"
        payload["installerSha256"] = release.get("installerSha256", "")
        payload["installerSize"] = installer_path.stat().st_size if installer_path.exists() else 0
    return payload


def human_size(size):
    try:
        size = int(size or 0)
    except Exception:
        size = 0
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f}{unit}" if unit != "B" else f"{int(value)}B"
        value /= 1024


def send_html(handler, html_text, status=200):
    data = html_text.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def download_page(handler):
    payload = latest_payload(handler)
    version = html.escape(str(payload.get("latestVersion") or payload.get("version") or "0.0.0"))
    changelog = html.escape(str(payload.get("changelog") or "暂无更新"))
    installer_url = html.escape(str(payload.get("installerUrl") or ""))
    zip_url = html.escape(str(payload.get("downloadUrl") or ""))
    manifest_url = html.escape(f"{public_origin(handler)}/api/update/check?version=0")
    installer_size = html.escape(human_size(payload.get("installerSize")))
    zip_size = html.escape(human_size(payload.get("zipSize")))
    if installer_url:
        recommended_button = f'<a class="btn primary" href="{installer_url}">下载免压缩安装版 <span>{installer_size}</span></a>'
        portable_button = f'<a class="btn secondary" href="{zip_url}">下载免安装压缩包 <span>{zip_size}</span></a>' if zip_url else ""
    else:
        recommended_button = f'<a class="btn primary" href="{zip_url}">下载最新版客户端 <span>{zip_size}</span></a>' if zip_url else ""
        portable_button = ""
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>白球 AI 下载中心</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #070b13;
      --panel: rgba(16, 24, 39, .78);
      --panel2: rgba(13, 148, 136, .13);
      --text: #ecfeff;
      --muted: #9ca3af;
      --cyan: #22d3ee;
      --green: #34d399;
      --line: rgba(148, 163, 184, .22);
      --shadow: 0 24px 80px rgba(0,0,0,.45);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 14% 12%, rgba(34,211,238,.24), transparent 32rem),
        radial-gradient(circle at 86% 14%, rgba(52,211,153,.16), transparent 30rem),
        linear-gradient(135deg, #05070d, var(--bg) 48%, #0b1220);
      color: var(--text);
    }}
    .wrap {{ width: min(1080px, calc(100% - 36px)); margin: 0 auto; padding: 54px 0 42px; }}
    .nav {{ display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:42px; color:var(--muted); }}
    .brand {{ display:flex; align-items:center; gap:12px; font-weight:800; color:var(--text); }}
    .logo {{ width:64px; height:64px; border-radius:0; background:transparent url('/assets/baiqiu-icon.png') center / contain no-repeat; filter:drop-shadow(0 8px 14px rgba(34,211,238,.24)); }}
    .card {{ border:1px solid var(--line); background: linear-gradient(180deg, var(--panel), rgba(8,13,24,.88)); border-radius:30px; padding:42px; box-shadow:var(--shadow); backdrop-filter: blur(18px); }}
    .hero {{ display:grid; grid-template-columns: 1.15fr .85fr; gap:32px; align-items:center; }}
    h1 {{ font-size: clamp(34px, 6vw, 68px); line-height:1.02; margin:0 0 18px; letter-spacing:-.05em; }}
    .sub {{ font-size:18px; line-height:1.8; color:#cbd5e1; margin:0 0 26px; }}
    .badges {{ display:flex; flex-wrap:wrap; gap:10px; margin:18px 0 30px; }}
    .badge {{ border:1px solid var(--line); border-radius:999px; padding:8px 12px; color:#d1fae5; background:rgba(15,23,42,.72); font-size:13px; }}
    .actions {{ display:flex; flex-wrap:wrap; gap:14px; }}
    .btn {{ display:inline-flex; align-items:center; justify-content:center; gap:10px; text-decoration:none; border-radius:18px; padding:15px 22px; font-weight:900; border:1px solid transparent; transition:.18s transform,.18s border-color,.18s background,.18s box-shadow; box-shadow:0 14px 30px rgba(0,0,0,.22); }}
    .btn:hover {{ transform: translateY(-2px); box-shadow:0 20px 42px rgba(34,211,238,.22); }}
    .btn span {{ opacity:.75; font-size:12px; font-weight:600; }}
    .primary {{ color:#031016; background:linear-gradient(135deg, var(--cyan), var(--green)); border-color:rgba(167,243,208,.62); box-shadow:0 16px 46px rgba(34,211,238,.26), inset 0 1px 0 rgba(255,255,255,.38); }}
    .secondary {{ color:var(--text); background:rgba(15,23,42,.8); border-color:var(--line); }}
    .side {{ border:1px solid var(--line); background:var(--panel2); border-radius:24px; padding:24px; }}
    .version {{ font-size:52px; font-weight:900; letter-spacing:-.06em; margin:8px 0; }}
    .label {{ color:var(--muted); font-size:14px; }}
    .notes {{ margin-top:22px; padding-top:20px; border-top:1px solid var(--line); line-height:1.8; color:#dbeafe; white-space:pre-wrap; }}
    .grid {{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:18px; }}
    .mini {{ border:1px solid var(--line); background:rgba(15,23,42,.58); border-radius:18px; padding:16px; color:#cbd5e1; }}
    .mini b {{ display:block; color:var(--text); margin-bottom:6px; }}
    .purchase {{ margin-top:18px; }}
    .purchase h2 {{ margin:0 0 10px; font-size:28px; letter-spacing:-.04em; }}
    .plans {{ display:grid; grid-template-columns:repeat(2,1fr); gap:14px; margin-top:16px; }}
    .plan {{ border:1px solid var(--line); background:rgba(2,6,23,.42); border-radius:22px; padding:20px; }}
    .plan .name {{ font-size:20px; font-weight:900; }}
    .price {{ display:flex; align-items:flex-end; gap:10px; margin:12px 0; }}
    .price .sale {{ font-size:38px; font-weight:950; color:#a7f3d0; letter-spacing:-.05em; }}
    .price .base {{ color:#94a3b8; text-decoration:line-through; padding-bottom:7px; }}
    .redeem {{ margin-top:14px; border:1px dashed rgba(34,211,238,.42); background:rgba(8,47,73,.28); border-radius:22px; padding:20px; }}
    .redeem form {{ display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end; }}
    .redeem label {{ display:block; color:#cbd5e1; font-size:13px; margin-bottom:6px; }}
    .redeem input {{ width:100%; border:1px solid var(--line); border-radius:14px; padding:13px 14px; background:#020617; color:var(--text); outline:none; }}
    .foot {{ color:var(--muted); font-size:13px; margin-top:22px; text-align:center; }}
    code {{ color:#a7f3d0; }}
    @media (max-width: 820px) {{ .hero,.grid,.plans,.redeem form {{ grid-template-columns:1fr; }} .card {{ padding:26px; border-radius:24px; }} .wrap {{ padding-top:28px; }} }}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="nav">
      <div class="brand"><div class="logo"></div><div>白球 AI 下载中心</div></div>
      <div>官方更新服务器 · 自动获取最新版</div>
    </div>
    <section class="card hero">
      <div>
        <h1>下载最新版<br>白球 AI</h1>
        <p class="sub">这里始终指向服务器发布的最新客户版。以后不需要再从桌面复制安装包，客户直接打开这个网站下载即可。</p>
        <div class="badges">
          <span class="badge">Windows 客户端</span>
          <span class="badge">自动更新</span>
          <span class="badge">授权保留</span>
          <span class="badge">版本 {version}</span>
        </div>
        <div class="actions">
          {recommended_button}
          {portable_button}
          <a class="btn secondary" href="{manifest_url}">查看更新清单</a>
        </div>
      </div>
      <aside class="side">
        <div class="label">当前最新版</div>
        <div class="version">v{version}</div>
        <div class="label">更新说明</div>
        <div class="notes">{changelog}</div>
      </aside>
    </section>
    <section class="grid">
      <div class="mini"><b>推荐安装版</b>适合普通客户，下载后双击安装。</div>
      <div class="mini"><b>免安装压缩包</b>适合测试或手动替换，解压后运行。</div>
        <div class="mini"><b>客户端自动更新</b>白球内置更新会读取官方更新接口。</div>
    </section>
    <div class="foot">官方更新服务器：{html.escape(public_origin(handler))}</div>
  </main>
</body>
</html>"""


def release_file(release):
    if not release:
        return None
    name = release.get("file") or ""
    if not name:
        return None
    return (RELEASES / name).resolve()


def simple_result_page(title, message, links=None):
    links = links or [("/", "返回客户下载页")]
    link_html = "".join(f'<a class="btn secondary" href="{html.escape(url)}">{html.escape(text)}</a>' for url, text in links)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>{admin_css()}</style>
</head>
<body>
  <main class="login card">
    <div class="brand"><div class="logo"></div><div>{html.escape(title)}</div></div>
    <p class="muted" style="font-size:16px">{html.escape(message)}</p>
    <div class="actions">{link_html}</div>
  </main>
</body>
</html>"""


def buy_page(handler, plan_key, error=""):
    data = read_license_store()
    plan = data.get("plans", {}).get(plan_key)
    if not plan or plan_key not in ("monthly", "six_months"):
        return simple_result_page("套餐不存在", "请选择月卡或 6 个月套餐。")
    error_html = f'<div class="notice error">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>购买 {html.escape(plan.get("name", ""))}</title>
  <style>{admin_css()}</style>
</head>
<body>
  <main class="login card">
    <div class="brand"><div class="logo"></div><div>购买 {html.escape(plan.get("name", ""))}</div></div>
    {error_html}
    <p class="muted">基础价 ¥{html.escape(str(plan.get("basePrice")))}，首次付费折扣价 ¥{html.escape(str(plan.get("firstPrice")))}。</p>
    <p class="muted">当前服务器已创建购买入口；微信/支付宝正式收款需要继续接入商户 API。现在提交后会生成“待支付订单”，管理员可在后台查看。</p>
    <form method="post" action="/buy">
      <input type="hidden" name="plan" value="{html.escape(plan_key)}">
      <label>账号/手机号/备注</label>
      <input name="customer" placeholder="用于管理员识别，可不填">
      <div class="actions"><button class="btn" type="submit">生成购买订单</button><a class="btn secondary" href="/">返回</a></div>
    </form>
  </main>
</body>
</html>"""


def admin_css():
    return """
    :root { color-scheme: dark; --bg:#07111f; --panel:#0f172a; --panel2:#111827; --line:rgba(148,163,184,.24); --text:#ecfeff; --muted:#94a3b8; --cyan:#22d3ee; --green:#34d399; --red:#fb7185; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family:"Microsoft YaHei",ui-sans-serif,system-ui,sans-serif; color:var(--text); background:radial-gradient(circle at 12% 12%,rgba(34,211,238,.22),transparent 28rem),linear-gradient(135deg,#05070d,var(--bg)); }
    a { color:#67e8f9; text-decoration:none; }
    .wrap { width:min(1760px,calc(100% - 32px)); margin:0 auto; padding:34px 0 46px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:900; font-size:22px; }
    .logo { width:62px; height:62px; border-radius:0; background:transparent url('/assets/baiqiu-icon.png') center / contain no-repeat; filter:drop-shadow(0 8px 14px rgba(34,211,238,.22)); }
    .card { border:1px solid var(--line); background:rgba(15,23,42,.82); border-radius:24px; padding:24px; box-shadow:0 24px 80px rgba(0,0,0,.35); backdrop-filter:blur(14px); }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
    .admin-shell { display:grid; grid-template-columns:260px minmax(0,1fr); gap:18px; align-items:start; }
    .module-nav { position:sticky; top:22px; display:flex; flex-direction:column; gap:12px; padding:16px; border:1px solid rgba(34,211,238,.24); border-radius:24px; background:linear-gradient(180deg,rgba(15,23,42,.88),rgba(2,6,23,.72)); box-shadow:0 24px 80px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.05); backdrop-filter:blur(14px); }
    .module-nav-title { color:#a5f3fc; font-size:13px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; margin:2px 4px 8px; }
    .module-switch { position:relative; width:100%; min-height:74px; text-align:left; border:1px solid rgba(148,163,184,.24); border-radius:18px; padding:13px 14px 13px 48px; color:#dbeafe; background:radial-gradient(circle at 20% 0%,rgba(34,211,238,.16),transparent 38%),linear-gradient(135deg,rgba(15,23,42,.96),rgba(30,41,59,.72)); cursor:pointer; overflow:hidden; transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease,background .18s ease; }
    .module-switch:before { content:attr(data-index); position:absolute; left:13px; top:15px; width:24px; height:24px; display:grid; place-items:center; border-radius:9px; color:#06202a; background:linear-gradient(135deg,var(--cyan),var(--green)); font-size:12px; font-weight:1000; box-shadow:0 0 24px rgba(34,211,238,.28); }
    .module-switch:after { content:""; position:absolute; inset:auto -38px -42px auto; width:92px; height:92px; border-radius:50%; background:rgba(34,211,238,.10); filter:blur(2px); }
    .module-switch strong { display:block; font-size:15px; margin-bottom:5px; color:#f8fafc; }
    .module-switch span { display:block; color:#94a3b8; font-size:12px; line-height:1.45; }
    .module-switch:hover { transform:translateY(-2px); border-color:rgba(34,211,238,.45); box-shadow:0 14px 38px rgba(8,47,73,.28); }
    .module-switch.active { border-color:rgba(45,212,191,.85); background:radial-gradient(circle at 18% 0%,rgba(45,212,191,.30),transparent 42%),linear-gradient(135deg,rgba(8,47,73,.94),rgba(15,23,42,.92)); box-shadow:0 0 0 1px rgba(34,211,238,.16),0 20px 50px rgba(34,211,238,.18); }
    .module-stage { min-width:0; }
    .module-grid { display:block; }
    .module-card { min-height:calc(100vh - 140px); display:none; flex-direction:column; gap:14px; }
    .module-card.active { display:flex; }
    .module-card h2 { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
    .module-card h2 span { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:4px 9px; color:#a7f3d0; font-size:12px; font-weight:800; background:rgba(20,83,45,.22); }
    .module-split { display:grid; grid-template-columns:1fr; gap:14px; }
    .module-scroll { overflow:auto; max-height:52vh; border-radius:16px; }
    .compact-form label { margin:10px 0 6px; }
    .compact-form textarea { min-height:78px; }
    .kpi-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .kpi { border:1px solid var(--line); background:rgba(2,6,23,.45); border-radius:16px; padding:13px; }
    .kpi span { display:block; color:var(--muted); font-size:12px; }
    .kpi b { display:block; margin-top:5px; font-size:22px; color:#ecfeff; }
    .login { width:min(460px,calc(100% - 32px)); margin:10vh auto; }
    h1,h2 { margin:0 0 16px; letter-spacing:-.03em; }
    label { display:block; color:#cbd5e1; font-size:14px; margin:14px 0 7px; }
    input,textarea,select { width:100%; border:1px solid var(--line); border-radius:14px; padding:13px 14px; background:#020617; color:var(--text); outline:none; }
    textarea { min-height:110px; resize:vertical; }
    input[type=file] { padding:11px; }
    .check { display:flex; align-items:center; gap:8px; margin-top:12px; color:#cbd5e1; }
    .check input { width:auto; }
    .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; border:0; border-radius:14px; padding:12px 16px; font-weight:800; cursor:pointer; color:#031016; background:linear-gradient(135deg,var(--cyan),var(--green)); }
    .btn.secondary { color:var(--text); background:#1f2937; border:1px solid var(--line); }
    .btn.danger { color:#fff; background:linear-gradient(135deg,#fb7185,#ef4444); box-shadow:0 0 24px rgba(239,68,68,.18); }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; }
    .muted { color:var(--muted); font-size:13px; line-height:1.7; }
    .notice { border:1px solid rgba(52,211,153,.35); background:rgba(16,185,129,.13); color:#d1fae5; border-radius:14px; padding:12px 14px; margin-bottom:16px; }
    .error { border-color:rgba(251,113,133,.42); background:rgba(244,63,94,.13); color:#ffe4e6; }
    .stat { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:18px; }
    .mini { border:1px solid var(--line); background:rgba(2,6,23,.45); border-radius:18px; padding:16px; }
    .mini b { display:block; font-size:24px; margin-top:6px; }
    table { width:100%; border-collapse:collapse; overflow:hidden; border-radius:16px; }
    th,td { text-align:left; border-bottom:1px solid var(--line); padding:11px 10px; color:#dbeafe; font-size:14px; }
    th { color:#93c5fd; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    .pill { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:5px 9px; color:#bbf7d0; background:rgba(20,83,45,.25); font-size:12px; }
    .device-cell { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (max-width: 980px) { .admin-shell { grid-template-columns:1fr; } .module-nav { position:relative; top:auto; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width: 860px) { .grid,.stat,.kpi-row { grid-template-columns:1fr; } .top { align-items:flex-start; flex-direction:column; } .module-nav { grid-template-columns:1fr; } .module-card { min-height:auto; } }

    /* Light operations console. This override keeps the authenticated backend and forms intact. */
    :root { color-scheme:light; --bg:#f3f5f7; --panel:#ffffff; --panel2:#f8fafb; --line:#dde3e9; --text:#1f2933; --muted:#6b7785; --cyan:#0fbb8d; --green:#0fbb8d; --red:#c74740; }
    body { color:var(--text); background:#f3f5f7; }
    a { color:#087f5b; }
    .wrap { width:min(1540px,calc(100% - 48px)); padding:28px 0 48px; }
    .top { min-height:72px; margin:0 -24px 24px; padding:14px 24px; background:#fff; border-bottom:1px solid #dde3e9; }
    .brand { color:#1f2933; font-size:19px; }
    .logo { width:38px; height:38px; filter:none; }
    .card { border:1px solid #dde3e9; border-radius:7px; padding:20px; background:#fff; box-shadow:none; backdrop-filter:none; }
    .login { width:min(460px,calc(100% - 32px)); margin:10vh auto; }
    .module-nav { border:0; border-radius:7px; padding:16px; background:#17212b; box-shadow:none; backdrop-filter:none; }
    .module-nav-title { color:#92a5b7; letter-spacing:0; }
    .module-switch { min-height:52px; border:0; border-radius:6px; padding:12px 12px 12px 42px; color:#b8c7d5; background:transparent; }
    .module-switch:before { left:12px; top:15px; width:18px; height:18px; border-radius:4px; color:#d9e2ec; background:transparent; box-shadow:none; border:2px solid currentColor; }
    .module-switch:after { display:none; }
    .module-switch strong { margin-bottom:2px; color:inherit; font-size:14px; }
    .module-switch span { color:#92a5b7; }
    .module-switch:hover,.module-switch.active { transform:none; border:0; color:#fff; background:#243342; box-shadow:none; }
    .module-switch.active { background:#243342; }
    .module-card { min-height:calc(100vh - 164px); }
    .module-card h2 { color:#1f2933; }
    .module-card h2 span,.pill { border-color:#d8e6df; color:#087f5b; background:#e8f7f1; }
    .kpi { border-color:#dde3e9; border-radius:7px; background:#fff; }
    .kpi span,.muted { color:#6b7785; }
    .kpi b { color:#1f2d3d; }
    label,.check { color:#465664; }
    input,textarea,select { border-color:#cbd5df; border-radius:5px; background:#fff; color:#273444; }
    input:focus,textarea:focus,select:focus { border-color:#0fbb8d; box-shadow:0 0 0 3px rgba(15,187,141,.13); }
    .btn { border-radius:5px; color:#fff; background:#087f5b; }
    .btn:hover { background:#066c4d; }
    .btn.secondary { color:#34495e; border-color:#cbd5df; background:#fff; }
    .btn.secondary:hover { background:#f4f7f9; }
    .notice { border-color:#bee3d2; border-radius:5px; color:#087f5b; background:#e8f7f1; }
    .mini { border-color:#dde3e9; border-radius:7px; background:#fff; }
    .module-scroll { border-radius:7px; border:1px solid #e7ebef; }
    table { border-radius:7px; }
    th,td { border-color:#e7ebef; color:#34495e; }
    th { color:#758391; background:#f8fafb; }
    """


def admin_login_page(error=""):
    error_html = f'<div class="notice error">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>白球 AI 管理者后台</title>
  <style>{admin_css()}</style>
</head>
<body>
  <main class="login card">
    <div class="brand"><div class="logo"></div><div>白球 AI 管理者后台</div></div>
    <p class="muted">请先登录。这里用于上传客户端安装包、发布最新版本和维护更新说明。</p>
    {error_html}
    <form method="post" action="/admin/login">
      <label>账号</label>
      <input name="username" value="admin" autocomplete="username">
      <label>密码</label>
      <input name="password" type="password" autocomplete="current-password" autofocus>
      <div class="actions"><button class="btn" type="submit">登录后台</button><a class="btn secondary" href="/">返回下载页</a></div>
    </form>
  </main>
</body>
</html>"""


def safe_version(value):
    value = str(value or "").strip().lstrip("vV")
    parts = value.split(".")
    if not parts or any((not part.isdigit()) for part in parts):
        raise ValueError("???????????????? 1.1.11")
    if len(parts) < 2:
        raise ValueError("????????????????? 1.1 ? 1.1.11")
    return ".".join(str(int(part)) for part in parts)


def upload_field(form, name):
    if name not in form:
        return None
    field = form[name]
    if isinstance(field, list):
        for item in field:
            if getattr(item, "filename", None):
                return item
        return field[0] if field else None
    return field


def save_upload(field, target):
    if field is None or not getattr(field, "filename", None):
        return False
    target = Path(target).resolve()
    if target.parent != RELEASES.resolve():
        raise ValueError("上传路径不安全")
    tmp = target.with_suffix(target.suffix + ".uploading")
    with tmp.open("wb") as out:
        shutil.copyfileobj(field.file, out, length=1024 * 1024)
    tmp.replace(target)
    return True


def publish_release_from_form(form, publisher=""):
    version = safe_version(form.getfirst("version", ""))
    notes = str(form.getfirst("notes", "") or "").strip() or f"白球 AI v{version} 更新"
    update_log = str(form.getfirst("update_log", "") or notes).strip()
    publisher = str(publisher or form.getfirst("publisher", "") or "???").strip()
    force_update = str(form.getfirst("forceUpdate", "")).lower() in ("1", "true", "yes", "on")
    zip_field = upload_field(form, "zip_file")
    installer_field = upload_field(form, "installer_file")
    if zip_field is None or not getattr(zip_field, "filename", None):
        raise ValueError("必须上传客户端 ZIP 包")
    if not str(zip_field.filename).lower().endswith(".zip"):
        raise ValueError("客户端包必须是 .zip 文件")
    if installer_field is not None and getattr(installer_field, "filename", None) and not str(installer_field.filename).lower().endswith(".exe"):
        raise ValueError("安装包必须是 .exe 文件")

    RELEASES.mkdir(parents=True, exist_ok=True)
    zip_name = f"baiqiu-customer-{version}.zip"
    zip_path = RELEASES / zip_name
    save_upload(zip_field, zip_path)

    item = {
        "version": version,
        "file": zip_name,
        "sha256": sha256_file(zip_path),
        "notes": notes,
        "updateLog": update_log,
        "publisher": publisher,
        "forceUpdate": force_update,
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    if installer_field is not None and getattr(installer_field, "filename", None):
        installer_name = f"BaiqiuAI-Setup-{version}.exe"
        installer_path = RELEASES / installer_name
        save_upload(installer_field, installer_path)
        item["installerFile"] = installer_name
        item["installerSha256"] = sha256_file(installer_path)

    manifest = read_json(MANIFEST, {"channels": {"stable": []}})
    channels = manifest.setdefault("channels", {})
    releases = channels.setdefault("stable", [])
    releases = [old for old in releases if str(old.get("version")) != version]
    releases.append(item)
    releases.sort(key=lambda old: version_key(old.get("version")), reverse=True)
    channels["stable"] = releases
    write_json(MANIFEST, manifest)
    return item


def admin_dashboard(handler, message="", error=""):
    payload = latest_payload(handler)
    latest = latest_release() or {}
    origin = public_origin(handler)
    latest_version = html.escape(str(payload.get("latestVersion") or "0.0.0"))
    latest_notes = html.escape(str(payload.get("changelog") or "暂无更新"))
    zip_size = html.escape(human_size(payload.get("zipSize")))
    installer_size = html.escape(human_size(payload.get("installerSize")))
    message_html = f'<div class="notice">{html.escape(message)}</div>' if message else ""
    error_html = f'<div class="notice error">{html.escape(error)}</div>' if error else ""

    manifest = read_json(MANIFEST, {"channels": {"stable": []}})
    rows = []
    for item in manifest.get("channels", {}).get("stable", [])[:12]:
        version = html.escape(str(item.get("version", "")))
        file_name = html.escape(str(item.get("file", "")))
        installer_name = html.escape(str(item.get("installerFile", "")))
        published = html.escape(str(item.get("publishedAt", "")))
        rows.append(
            f"<tr><td><span class='pill'>v{version}</span></td><td>{file_name}</td><td>{installer_name or '-'}</td><td>{published}</td></tr>"
        )
    rows_html = "\n".join(rows) or "<tr><td colspan='4'>还没有发布记录</td></tr>"

    license_store = read_license_store()
    all_codes = license_store.get("codes", [])
    code_total = len(all_codes)
    code_redeemed = len([item for item in all_codes if item.get("redeemedAt")])
    code_available = code_total - code_redeemed
    code_rows = []
    for item in list(reversed(all_codes))[:12]:
        code = html.escape(str(item.get("code", "")))
        status_raw = str(item.get("status", "active"))
        if status_raw == "recycled":
            status = "???"
        else:
            status = "???" if item.get("redeemedAt") else "??"
        created = html.escape(str(item.get("createdAt", "")))
        redeemed_name = html.escape(str(item.get("redeemedName") or item.get("redeemedBy") or "-"))
        redeemed_phone = html.escape(str(item.get("redeemedPhone") or "-"))
        action = f'<div style="display:flex;gap:8px"><button class="btn secondary" type="button" data-code="{code}" onclick="var t=document.createElement(\'textarea\');t.value=this.dataset.code;document.body.appendChild(t);t.select();document.execCommand(\'copy\');t.remove();this.textContent=\'已复制\'">复制</button><form method="post" action="/admin/codes/recycle" style="margin:0"><input type="hidden" name="code" value="{code}"><button class="btn secondary" type="submit">回收</button></form></div>'
        code_rows.append(f"<tr><td><code>{code}</code></td><td>{status}</td><td>{redeemed_name}</td><td>{redeemed_phone}</td><td>{created}</td><td>{action}</td></tr>")
    code_rows_html = "\n".join(code_rows) or "<tr><td colspan='6'>??????</td></tr>"

    order_rows = []
    for item in list(reversed(license_store.get("orders", [])))[:10]:
        order_id = html.escape(str(item.get("orderId", "")))
        plan_name = html.escape(str(item.get("planName", "")))
        price = html.escape(str(item.get("firstPrice", "")))
        customer = html.escape(str(item.get("customer", "")) or "-")
        created = html.escape(str(item.get("createdAt", "")))
        status_raw = str(item.get("status", "pending_review"))
        status = html.escape({"pending_review": "待审核", "pending_payment": "待付款", "approved": "已发放"}.get(status_raw, status_raw))
        action = "-"
        if status_raw != "approved":
            action = f'<form method="post" action="/admin/orders/approve" style="margin:0"><input type="hidden" name="orderId" value="{order_id}"><button class="btn" type="submit">确认已付款并发放</button></form>'
        order_rows.append(f"<tr><td><code>{order_id}</code></td><td>{plan_name}</td><td>¥{price}</td><td>{customer}</td><td>{status}</td><td>{created}</td><td>{action}</td></tr>")
    order_rows_html = "\n".join(order_rows) or "<tr><td colspan='7'>还没有购买订单</td></tr>"

    customer_rows = []
    approved_orders = [item for item in license_store.get("orders", []) if item.get("status") == "approved"]
    online_clients = sorted(ONLINE_CLIENTS.items(), key=lambda kv: kv[1].get("lastSeen", 0), reverse=True)
    for ip, meta in online_clients[:12]:
        last_seen = float(meta.get("lastSeen", 0) or 0)
        online_minutes = max(0, int((time.time() - last_seen) / 60))
        customer_rows.append(
            f"<tr><td><span class='pill'>在线</span></td><td>{html.escape(ip)}</td><td>-</td><td>{online_minutes} 分钟前</td><td>{html.escape(str(meta.get('userAgent', '')))}</td></tr>"
        )
    for item in approved_orders[:12]:
        plan_name = html.escape(str(item.get("planName", "")))
        customer = html.escape(str(item.get("customer", "")) or "-")
        approved_at = item.get("approvedAt") or item.get("paidAt") or item.get("createdAt") or ""
        expires_at = item.get("expiresAt") or ""
        remain_days = "-"
        if expires_at:
            try:
                remain_days = max(0, int((time.mktime(time.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ")) - time.time()) / 86400))
                remain_days = f"{remain_days} 天"
            except Exception:
                remain_days = "-"
        inactive_days = "-"
        if approved_at:
            try:
                inactive_days = f"{max(0, int((time.time() - time.mktime(time.strptime(approved_at, '%Y-%m-%dT%H:%M:%SZ'))) / 86400))} 天"
            except Exception:
                inactive_days = "-"
        customer_rows.append(
            f"<tr><td><span class='pill'>已发放</span></td><td>{customer}</td><td>{plan_name}</td><td>{remain_days}</td><td>{inactive_days}</td></tr>"
        )
    customer_rows_html = "\n".join(customer_rows) or "<tr><td colspan='5'>还没有顾客跟踪数据</td></tr>"
    online_user_count = len(ONLINE_CLIENTS)
    approved_count = len(approved_orders)
    pending_payment_count = len([item for item in license_store.get("orders", []) if item.get("status") == "pending_payment"])

    accounting_store = read_accounting_store()
    entries = list(reversed(accounting_store.get("entries", [])))
    summary = accounting_summary(accounting_store.get("entries", []))
    accounting_rows = []
    for item in entries[:20]:
        kind_label = "收入" if item.get("kind") == "income" else "支出"
        sign = "+" if item.get("kind") == "income" else "-"
        amount = html.escape(f"{float(item.get('amount', 0) or 0):.2f}")
        category = html.escape(str(item.get("category", "")))
        method = html.escape(str(item.get("method", "")))
        date = html.escape(str(item.get("date", "")))
        note = html.escape(str(item.get("note", "")) or "-")
        accounting_rows.append(
            f"<tr><td>{date}</td><td>{kind_label}</td><td>{category}</td><td>{method}</td><td>{sign}¥{amount}</td><td>{note}</td></tr>"
        )
    accounting_rows_html = "\n".join(accounting_rows) or "<tr><td colspan='6'>还没有记账记录</td></tr>"

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>白球 AI 管理者后台</title>
  <style>{admin_css()}</style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand"><div class="logo"></div><div>白球 AI 管理者后台</div></div>
      <div class="actions">
        <a class="btn secondary" href="/" target="_blank">打开客户下载页</a>
        <a class="btn secondary" href="/update.json" target="_blank">查看更新接口</a>
        <form method="post" action="/admin/logout" style="margin:0"><button class="btn secondary" type="submit">退出登录</button></form>
      </div>
    </div>
    {message_html}
    {error_html}
    <section class="stat">
      <div class="mini"><span class="muted">当前最新版</span><b>v{latest_version}</b></div>
      <div class="mini"><span class="muted">ZIP 包大小</span><b>{zip_size}</b></div>
      <div class="mini"><span class="muted">安装包大小</span><b>{installer_size}</b></div>
    </section>
    <section class="stat">
      <div class="mini"><span class="muted">记账总收入</span><b>¥{summary["income"]:.2f}</b></div>
      <div class="mini"><span class="muted">记账总支出</span><b>¥{summary["expense"]:.2f}</b></div>
      <div class="mini"><span class="muted">当前余额</span><b>¥{summary["balance"]:.2f}</b></div>
    </section>
    <section class="grid" style="margin-bottom:18px">
      <div class="card">
        <h2>记账系统</h2>
        <p class="muted">用于记录购买收入、服务器费用、推广费用等流水。这里先做轻量版，数据保存在服务器 accounting.json。</p>
        <form method="post" action="/admin/accounting/add">
          <label>类型</label>
          <select name="kind">
            <option value="income">收入</option>
            <option value="expense">支出</option>
          </select>
          <label>金额</label>
          <input name="amount" type="number" min="0.01" step="0.01" placeholder="例如 19.9" required>
          <label>分类</label>
          <input name="category" placeholder="例如 授权收入 / 服务器费用" value="授权收入">
          <label>付款方式</label>
          <input name="method" placeholder="微信 / 支付宝 / 银行卡" value="微信">
          <label>日期</label>
          <input name="date" type="date">
          <label>备注</label>
          <textarea name="note" placeholder="例如 月卡客户张三 / 服务器续费"></textarea>
          <div class="actions"><button class="btn" type="submit">保存记账</button></div>
        </form>
      </div>
      <div class="card">
        <h2>最近流水</h2>
        <table>
          <thead><tr><th>日期</th><th>类型</th><th>分类</th><th>方式</th><th>金额</th><th>备注</th></tr></thead>
          <tbody>{accounting_rows_html}</tbody>
        </table>
      </div>
    </section>
    <section class="grid">
      <div class="card">
        <h2>发布新客户端</h2>
        <p class="muted">上传后会自动生成 SHA256，并把最新版写入 updates.json。客户下载页和客户端更新接口会立刻指向新版本。</p>
        <form method="post" action="/admin/upload" enctype="multipart/form-data">
          <label>版本号</label>
          <input name="version" placeholder="例如 1.1.5" required>
          <label>客户端 ZIP 包（必填）</label>
          <input name="zip_file" type="file" accept=".zip" required>
          <label>Windows 安装包 EXE（可选，但推荐）</label>
          <input name="installer_file" type="file" accept=".exe">
          <label>更新说明</label>
          <textarea name="notes" placeholder="写给客户看的更新内容"></textarea>
          <label class="check"><input name="forceUpdate" type="checkbox" checked> 标记为强制更新</label>
          <div class="actions"><button class="btn" type="submit">上传并发布</button></div>
        </form>
      </div>
      <div class="card">
        <h2>当前发布信息</h2>
        <p class="muted">客户网址：<a href="{html.escape(origin)}/" target="_blank">{html.escape(origin)}/</a></p>
        <p class="muted">最新版 ZIP：<a href="{html.escape(str(payload.get("downloadUrl") or "#"))}" target="_blank">{html.escape(str(payload.get("downloadUrl") or "暂无"))}</a></p>
        <p class="muted">最新版安装包：<a href="{html.escape(str(payload.get("installerUrl") or "#"))}" target="_blank">{html.escape(str(payload.get("installerUrl") or "暂无"))}</a></p>
        <h2 style="margin-top:22px">更新说明</h2>
        <div class="mini" style="white-space:pre-wrap">{latest_notes}</div>
      </div>
    </section>
    <section class="card" style="margin-top:18px">
      <h2>最近发布记录</h2>
      <table>
        <thead><tr><th>版本</th><th>ZIP 文件</th><th>安装包</th><th>发布时间</th></tr></thead>
        <tbody>{rows_html}</tbody>
      </table>
    </section>
    <section class="grid" style="margin-top:18px">
      <div class="card">
        <h2>生成兑换码</h2>
        <p class="muted">永久兑换码生成系统：卡密玩法已取消，这里生成的是永久兑换码。总数 {code_total} 个，可用 {code_available} 个，已兑换 {code_redeemed} 个。</p>
        <form method="post" action="/admin/codes/create">
          <label>生成数量</label>
          <input name="count" type="number" min="1" max="200" value="1">
          <label>备注</label>
          <input name="note" placeholder="例如 老客户补发 / 内测用户">
          <div class="actions"><button class="btn" type="submit">生成永久兑换码</button></div>
        </form>
      </div>
      <div class="card">
        <h2>最近购买订单</h2>
        <table>
          <thead><tr><th>订单</th><th>套餐</th><th>金额</th><th>客户</th><th>状态</th><th>时间</th><th>审核</th></tr></thead>
          <tbody>{order_rows_html}</tbody>
        </table>
      </div>
    </section>
    <section class="card" style="margin-top:18px">
      <h2>最近兑换码</h2>
      <table>
        <thead><tr><th>兑换码</th><th>状态</th><th>兑换人</th><th>生成时间</th></tr></thead>
        <tbody>{code_rows_html}</tbody>
      </table>
    </section>
  </main>
</body>
</html>"""

def admin_programmer_dashboard(handler, message="", error=""):
    payload = latest_payload(handler)
    origin = public_origin(handler)
    latest_version = html.escape(str(payload.get("latestVersion") or payload.get("version") or "0.0.0"))
    latest_notes = html.escape(str(payload.get("changelog") or "暂无更新"))
    zip_size = html.escape(human_size(payload.get("zipSize")))
    installer_size = html.escape(human_size(payload.get("installerSize")))
    message_html = f'<div class="notice">{html.escape(message)}</div>' if message else ""
    error_html = f'<div class="notice error">{html.escape(error)}</div>' if error else ""
    manifest = read_json(MANIFEST, {"channels": {"stable": []}})
    release_rows = []
    for item in manifest.get("channels", {}).get("stable", [])[:10]:
        version = html.escape(str(item.get("version", "")))
        file_name = html.escape(str(item.get("file", "")))
        installer_name = html.escape(str(item.get("installerFile", "")) or "-")
        published = html.escape(str(item.get("publishedAt", "")))
        release_log = html.escape(str(item.get("updateLog") or item.get("notes") or "-"))
        publisher = html.escape(str(item.get("publisher") or "-"))
        release_rows.append(f"<tr><td><span class='pill'>v{version}</span></td><td>{file_name}</td><td>{installer_name}</td><td>{publisher}</td><td>{release_log}</td><td>{published}</td></tr>")
    release_rows_html = "\n".join(release_rows) or "<tr><td colspan='4'>还没有发布记录</td></tr>"
    auth = current_auth(handler) or {"username": "programmer"}
    username = html.escape(str(auth.get("username", "programmer")))
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>白球 AI 程序员后台</title><style>{admin_css()}</style></head>
<body><main class="wrap"><div class="top"><div class="brand"><div class="logo"></div><div>白球 AI 程序员后台</div></div><div class="actions"><span class="pill">程序员：{username}</span><form method="post" action="/admin/logout" style="margin:0"><button class="btn secondary" type="submit">退出登录</button></form></div></div>{message_html}{error_html}
<section class="admin-shell"><aside class="module-nav"><div class="module-nav-title">Programmer</div><button class="module-switch active" type="button" data-index="01" data-module-target="version"><strong>版本更新</strong><span>仅可上传和发布版本</span></button></aside>
<section class="module-stage module-grid"><div class="card module-card active" data-module="version"><h2>版本更新 <span>v{latest_version}</span></h2><div class="kpi-row"><div class="kpi"><span>ZIP 包大小</span><b>{zip_size}</b></div><div class="kpi"><span>安装包大小</span><b>{installer_size}</b></div></div><p class="muted">客户网址：<a href="{html.escape(origin)}/" target="_blank">{html.escape(origin)}/</a></p><p class="muted">更新说明：{latest_notes}</p><form class="compact-form" method="post" action="/admin/upload" enctype="multipart/form-data"><label>版本号</label><input name="version" placeholder="例如 1.1.11" required><label>客户版 ZIP 包（必填）</label><input name="zip_file" type="file" accept=".zip" required><label>Windows 安装包 EXE（可选）</label><input name="installer_file" type="file" accept=".exe"><label>更新说明</label><textarea name="notes" placeholder="写给客户看的更新内容"></textarea><label class="check"><input name="forceUpdate" type="checkbox" checked> 标记为强制更新</label><div class="actions"><button class="btn" type="submit">上传并发布</button></div></form><div class="module-scroll"><table><thead><tr><th>版本</th><th>ZIP</th><th>安装包</th><th>时间</th></tr></thead><tbody>{release_rows_html}</tbody></table></div></div></section></section></main></body></html>"""


def admin_dashboard_v2(handler, message="", error=""):
    auth = current_auth(handler)
    if auth and auth.get("role") == "programmer":
        return admin_programmer_dashboard(handler, message, error)
    payload = latest_payload(handler)
    origin = public_origin(handler)
    latest_version = html.escape(str(payload.get("latestVersion") or payload.get("version") or "0.0.0"))
    latest_notes = html.escape(str(payload.get("changelog") or "暂无更新"))
    zip_size = html.escape(human_size(payload.get("zipSize")))
    installer_size = html.escape(human_size(payload.get("installerSize")))
    message_html = f'<div class="notice">{html.escape(message)}</div>' if message else ""
    error_html = f'<div class="notice error">{html.escape(error)}</div>' if error else ""

    manifest = read_json(MANIFEST, {"channels": {"stable": []}})
    release_rows = []
    for item in manifest.get("channels", {}).get("stable", [])[:10]:
        version = html.escape(str(item.get("version", "")))
        file_name = html.escape(str(item.get("file", "")))
        installer_name = html.escape(str(item.get("installerFile", "")) or "-")
        published = html.escape(str(item.get("publishedAt", "")))
        release_log = html.escape(str(item.get("updateLog") or item.get("notes") or "-"))
        publisher = html.escape(str(item.get("publisher") or "-"))
        release_rows.append(f"<tr><td><span class='pill'>v{version}</span></td><td>{file_name}</td><td>{installer_name}</td><td>{publisher}</td><td>{release_log}</td><td>{published}</td></tr>")
    release_rows_html = "\n".join(release_rows) or "<tr><td colspan='4'>还没有发布记录</td></tr>"

    accounting_store = read_accounting_store()
    entries = list(reversed(accounting_store.get("entries", [])))
    summary = accounting_summary(accounting_store.get("entries", []))
    accounting_rows = []
    for item in entries[:18]:
        kind_label = "收入" if item.get("kind") == "income" else "支出"
        sign = "+" if item.get("kind") == "income" else "-"
        amount = html.escape(f"{float(item.get('amount', 0) or 0):.2f}")
        category = html.escape(str(item.get("category", "")))
        method = html.escape(str(item.get("method", "")))
        date = html.escape(str(item.get("date", "")))
        note = html.escape(str(item.get("note", "")) or "-")
        accounting_rows.append(f"<tr><td>{date}</td><td>{kind_label}</td><td>{category}</td><td>{method}</td><td>{sign}¥{amount}</td><td>{note}</td></tr>")
    accounting_rows_html = "\n".join(accounting_rows) or "<tr><td colspan='6'>还没有记账记录</td></tr>"

    license_store = read_license_store()
    all_codes = license_store.get("codes", [])
    orders = license_store.get("orders", [])
    blacklist = license_store.get("blacklist", [])
    plans = license_store.get("plans", {})
    plan_labels = {"weekly": "周卡", "monthly": "月卡", "six_months": "半年卡", "redeem_lifetime": "永久"}
    plan_options = "\n".join(
        f'<option value="{key}">{html.escape(plan_labels.get(key, str(plans.get(key, {}).get("name", key))))}</option>'
        for key in ("redeem_lifetime", "monthly", "weekly", "six_months")
    )
    code_total = len(all_codes)
    code_redeemed = len([item for item in all_codes if item.get("redeemedAt")])
    code_available = code_total - code_redeemed
    code_rows = []
    for item in list(reversed(all_codes))[:18]:
        code = html.escape(str(item.get("code", "")))
        status_raw = str(item.get("status", "active"))
        if status_raw == "recycled":
            status = "\u5df2\u56de\u6536"
        else:
            status = "\u5df2\u5151\u6362" if item.get("redeemedAt") else "\u53ef\u7528"
        created = html.escape(str(item.get("createdAt", "")))
        redeemed_name = html.escape(str(item.get("redeemedName") or item.get("redeemedBy") or "-"))
        redeemed_phone = html.escape(str(item.get("redeemedPhone") or "-"))
        action = f'<div style="display:flex;gap:8px"><button class="btn secondary" type="button" data-code="{code}" onclick="var t=document.createElement(\'textarea\');t.value=this.dataset.code;document.body.appendChild(t);t.select();document.execCommand(\'copy\');t.remove();this.textContent=\'已复制\'">复制</button><form method="post" action="/admin/codes/recycle" style="margin:0"><input type="hidden" name="code" value="{code}"><button class="btn secondary" type="submit">\u56de\u6536</button></form></div>'
        code_rows.append(f"<tr><td><code>{code}</code></td><td>{status}</td><td>{redeemed_name}</td><td>{redeemed_phone}</td><td>{created}</td><td>{action}</td></tr>")
    code_rows_html = "\n".join(code_rows) or "<tr><td colspan='6'>\u8fd8\u6ca1\u6709\u5151\u6362\u7801</td></tr>"

    order_rows = []
    for item in list(reversed(orders))[:16]:
        order_id_raw = str(item.get("orderId", ""))
        order_id = html.escape(order_id_raw)
        plan_name = html.escape(str(item.get("planName", "")))
        price = html.escape(str(item.get("firstPrice", "")))
        customer = html.escape(str(item.get("customer", "")) or "-")
        created = html.escape(str(item.get("createdAt", "")))
        status_raw = str(item.get("status", "pending_review"))
        status = html.escape({"pending_review": "待审核", "pending_payment": "待付款", "approved": "已发放"}.get(status_raw, status_raw))
        action = "-"
        if status_raw != "approved":
            action = f'<form method="post" action="/admin/orders/approve" style="margin:0"><input type="hidden" name="orderId" value="{order_id}"><button class="btn" type="submit">确认发放</button></form>'
        order_rows.append(f"<tr><td><code>{order_id}</code></td><td>{plan_name}</td><td>¥{price}</td><td>{customer}</td><td>{status}</td><td>{created}</td><td>{action}</td></tr>")
    order_rows_html = "\n".join(order_rows) or "<tr><td colspan='7'>还没有购买订单</td></tr>"

    approved_orders = [item for item in orders if item.get("status") == "approved"]
    pending_review_count = len([item for item in orders if item.get("status") == "pending_review"])
    pending_payment_count = len([item for item in orders if item.get("status") == "pending_payment"])
    customer_rows = []
    customer_query = parse_qs(urlparse(handler.path).query)
    try:
        customer_page = max(1, int((customer_query.get("page") or ["1"])[0] or "1"))
    except Exception:
        customer_page = 1
    all_customers = []
    for ip, meta in sorted(ONLINE_CLIENTS.items(), key=lambda kv: kv[1].get("lastSeen", 0), reverse=True):
        last_seen = float(meta.get("lastSeen", 0) or 0)
        ago = max(0, int((time.time() - last_seen) / 60))
        raw_name = str(meta.get("customerName") or meta.get("name") or "").strip()
        raw_phone = str(meta.get("phone") or "").strip()
        abnormal = "\u5f02\u5e38" if blacklist_match(license_store, ip=ip, customer=raw_name, phone=raw_phone) else "\u6b63\u5e38"
        device_full = str(meta.get("deviceId") or meta.get("userAgent") or "-")
        device_short = html.escape(device_full[:42] + ("..." if len(device_full) > 42 else ""))
        device_title = html.escape(device_full, quote=True)
        all_customers.append(("\u5728\u7ebf", html.escape(ip), html.escape(raw_name or "-"), html.escape(raw_phone or "-"), abnormal, f"{ago} \u5206\u949f\u524d", device_short, device_title))
    for item in list(reversed(approved_orders)):
        raw_customer = str(item.get("customer", "") or "").strip()
        raw_phone = str(item.get("phone", "") or item.get("customerPhone", "") or "").strip()
        raw_ip = str(item.get("ip", "") or "-")
        abnormal = "\u5f02\u5e38" if blacklist_match(license_store, ip=raw_ip if raw_ip != "-" else "", customer=raw_customer, phone=raw_phone) else "\u6b63\u5e38"
        expires_at = str(item.get("expiresAt", "") or "")
        remain = "-"
        try:
            if expires_at:
                remain = f"{max(0, int((time.mktime(time.strptime(expires_at, '%Y-%m-%dT%H:%M:%SZ')) - time.time()) / 86400))} \u5929"
        except Exception:
            pass
        device_full = str(item.get("deviceId", "") or "-")
        device_short = html.escape(device_full[:42] + ("..." if len(device_full) > 42 else ""))
        device_title = html.escape(device_full, quote=True)
        all_customers.append(("\u4f1a\u5458", html.escape(raw_ip), html.escape(raw_customer or "-"), html.escape(raw_phone or "-"), abnormal, remain, device_short, device_title))
    page_rows = all_customers[(customer_page - 1) * 10: customer_page * 10]
    customer_rows = []
    for row in page_rows:
        customer_rows.append(
            f"<tr><td><span class='pill'>{row[0]}</span></td><td>{row[1]}</td><td>{row[2]}</td><td>{row[3]}</td><td>{row[4]}</td><td>{row[5]}</td><td class='device-cell' title='{row[7]}'>{row[6]}</td></tr>"
        )
    customer_rows_html = "\n".join(customer_rows) or "<tr><td colspan='7'>\u8fd8\u6ca1\u6709\u987e\u5ba2\u8ddf\u8e2a\u6570\u636e</td></tr>"
    customer_page_nav = f'<div class="actions" style="margin-top:12px"><a class="btn secondary" href="?page={max(1, customer_page - 1)}">\u4e0a\u4e00\u9875</a><span class="pill">\u7b2c {customer_page} \u9875 / \u6bcf\u987510\u4f4d\u987e\u5ba2</span><a class="btn secondary" href="?page={customer_page + 1}">\u4e0b\u4e00\u9875</a></div>'

    status_payload = developer_status_payload()
    abnormal_rows = []
    for issue in status_payload.get("issues", []):
        abnormal_rows.append(f"<tr><td>{html.escape(str(issue.get('type', '')))}</td><td>{html.escape(str(issue.get('count', '')))}</td><td>{html.escape(str(issue.get('message', '')))}</td></tr>")
    blacklist_rows = []
    for item in list(reversed(blacklist))[:30]:
        if item.get("status", "active") != "active":
            continue
        item_id = html.escape(str(item.get("id", "")))
        status = "\u6709\u6548"
        duration = html.escape(str(item.get("durationLabel", "\u672a\u77e5") or "\u672a\u77e5"))
        expires = html.escape(str(item.get("expiresAt", "") or "\u672a\u77e5"))
        release_action = f'<form method="post" action="/admin/blacklist/release" style="margin:0"><input type="hidden" name="id" value="{item_id}"><button class="btn secondary" type="submit">\u89e3\u9664</button></form>'
        blacklist_rows.append(f"<tr><td>{status}</td><td>{html.escape(str(item.get('ip', '') or '-'))}</td><td>{html.escape(str(item.get('name', '') or '-'))}</td><td>{html.escape(str(item.get('phone', '') or '-'))}</td><td>{duration}</td><td>{expires}</td><td>{html.escape(str(item.get('reason', '') or '-'))}</td><td>{release_action}</td></tr>")
    blacklist_rows_html = "\n".join(blacklist_rows) or "<tr><td colspan='8'>\u5c0f\u9ed1\u5c4b\u6682\u65f6\u4e3a\u7a7a</td></tr>"
    config = ensure_admin_config()
    programmer_rows = []
    for user in config.get("programmers", []):
        username = html.escape(str(user.get("username", "")))
        status = "\u542f\u7528" if user.get("active") is not False else "\u5df2\u6536\u56de"
        note = html.escape(str(user.get("note", "")) or "-")
        created = html.escape(str(user.get("createdAt", "")) or "-")
        action = "-" if user.get("active") is False else f'<form method="post" action="/admin/programmers/revoke" style="margin:0"><input type="hidden" name="username" value="{username}"><button class="btn danger" type="submit">\u6536\u56de\u8d26\u53f7</button></form>'
        programmer_rows.append(f"<tr><td>{username}</td><td>\u4ec5\u7248\u672c\u66f4\u65b0</td><td>{status}</td><td>{note}</td><td>{created}</td><td>{action}</td></tr>")
    programmer_rows_html = "\\n".join(programmer_rows) or "<tr><td colspan='6'>\u8fd8\u6ca1\u6709\u7a0b\u5e8f\u5458\u5b50\u8d26\u53f7</td></tr>"

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>白球 AI 管理者后台</title>
  <style>{admin_css()}</style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand"><div class="logo"></div><div>白球 AI 管理者后台</div></div>
      <div class="actions">
        <a class="btn secondary" href="/" target="_blank">打开客户下载页</a>
        <a class="btn secondary" href="/update.json" target="_blank">查看更新接口</a>
        <form method="post" action="/admin/logout" style="margin:0"><button class="btn secondary" type="submit">退出登录</button></form>
      </div>
    </div>
    {message_html}
    {error_html}
    <section class="admin-shell">
      <aside class="module-nav" aria-label="后台模块切换">
        <div class="module-nav-title">Control Panel</div>
        <button class="module-switch active" type="button" data-index="01" data-module-target="accounting"><strong>记账模块</strong><span>收入支出、余额和流水记录</span></button>
        <button class="module-switch" type="button" data-index="02" data-module-target="customers"><strong>顾客跟踪</strong><span>在线顾客、异常账号、小黑屋</span></button>
        <button class="module-switch" type="button" data-index="03" data-module-target="codes"><strong>兑换码模块</strong><span>永久、月卡、周卡、半年卡</span></button>
        <button class="module-switch" type="button" data-index="04" data-module-target="version"><strong>版本更新</strong><span>上传客户端和发布版本</span></button>
        <button class="module-switch" type="button" data-index="05" data-module-target="programmers"><strong>程序员管理</strong><span>发放或收回版本更新子账号</span></button>
      </aside>
      <section class="module-stage module-grid">
      <div class="card module-card" data-module="version">
        <h2>1. 版本更新模块 <span>v{latest_version}</span></h2>
        <div class="kpi-row">
          <div class="kpi"><span>ZIP 包大小</span><b>{zip_size}</b></div>
          <div class="kpi"><span>安装包大小</span><b>{installer_size}</b></div>
        </div>
        <p class="muted">客户网址：<a href="{html.escape(origin)}/" target="_blank">{html.escape(origin)}/</a></p>
        <p class="muted">更新说明：{latest_notes}</p>
        <form class="compact-form" method="post" action="/admin/upload" enctype="multipart/form-data">
          <label>版本号</label><input name="version" placeholder="例如 1.1.11" required>
          <label>客户版 ZIP 包（必填）</label><input name="zip_file" type="file" accept=".zip" required>
          <label>Windows 安装包 EXE（可选）</label><input name="installer_file" type="file" accept=".exe">
          <label>\u66f4\u65b0\u8bf4\u660e</label><textarea name="notes" placeholder="\u5199\u7ed9\u5ba2\u6237\u770b\u7684\u66f4\u65b0\u5185\u5bb9"></textarea>
          <label>\u66f4\u65b0\u65e5\u5fd7</label><textarea name="update_log" placeholder="\u7a0b\u5e8f\u5458\u586b\u5199\u672c\u6b21\u66f4\u65b0\u5185\u5bb9"></textarea>
          <label class="check"><input name="forceUpdate" type="checkbox" checked> 标记为强制更新</label>
          <div class="actions"><button class="btn" type="submit">上传并发布</button></div>
        </form>
        <div class="module-scroll"><table><thead><tr><th>\u7248\u672c</th><th>ZIP</th><th>\u5b89\u88c5\u5305</th><th>\u63d0\u4ea4\u4eba</th><th>\u66f4\u65b0\u65e5\u5fd7</th><th>\u65f6\u95f4</th></tr></thead><tbody>{release_rows_html}</tbody></table></div>
      </div>

      <div class="card module-card active" data-module="accounting">
        <h2>2. 记账模块 <span>余额 ¥{summary["balance"]:.2f}</span></h2>
        <div class="kpi-row">
          <div class="kpi"><span>总收入</span><b>¥{summary["income"]:.2f}</b></div>
          <div class="kpi"><span>总支出</span><b>¥{summary["expense"]:.2f}</b></div>
        </div>
        <form class="compact-form" method="post" action="/admin/accounting/add">
          <label>类型</label><select name="kind"><option value="income">收入</option><option value="expense">支出</option></select>
          <label>金额</label><input name="amount" type="number" min="0.01" step="0.01" placeholder="例如 19.9" required>
          <label>分类</label><input name="category" placeholder="授权收入 / 服务器费用" value="授权收入">
          <label>付款方式</label><input name="method" placeholder="微信 / 支付宝 / 银行卡" value="微信">
          <label>日期</label><input name="date" type="date">
          <label>备注</label><textarea name="note" placeholder="例如 月卡客户张三 / 服务器续费"></textarea>
          <div class="actions"><button class="btn" type="submit">保存记账</button></div>
        </form>
        <div class="module-scroll"><table><thead><tr><th>日期</th><th>类型</th><th>分类</th><th>方式</th><th>金额</th><th>备注</th></tr></thead><tbody>{accounting_rows_html}</tbody></table></div>
      </div>

      <div class="card module-card" data-module="customers">
        <h2>3. \u987e\u5ba2\u8ddf\u8e2a\u770b\u677f <span>{len(ONLINE_CLIENTS)} \u5728\u7ebf</span></h2>
        <div class="kpi-row">
          <div class="kpi"><span>\u5728\u7ebf\u987e\u5ba2</span><b>{len(ONLINE_CLIENTS)}</b></div>
          <div class="kpi"><span>\u5df2\u53d1\u653e\u4f1a\u5458</span><b>{len(approved_orders)}</b></div>
          <div class="kpi"><span>\u5c0f\u9ed1\u5c4b\u6709\u6548\u8bb0\u5f55</span><b>{len([x for x in blacklist if x.get("status", "active") == "active"])}</b></div>
          <div class="kpi"><span>\u6bcf\u9875\u987e\u5ba2</span><b>10</b></div>
        </div>
        <p class="muted">\u7a97\u53e3\u770b\u677f\uff1a\u663e\u793a\u987e\u5ba2 IP\u3001\u59d3\u540d\u3001\u7535\u8bdd\u3001\u5f02\u5e38\u884c\u4e3a\u548c\u8bbe\u5907\u6458\u8981\uff1b\u8bbe\u5907\u8fc7\u957f\u4f1a\u81ea\u52a8\u7f29\u5199\u3002</p>
        <div class="module-scroll"><table><thead><tr><th>\u72b6\u6001</th><th>IP</th><th>\u59d3\u540d</th><th>\u7535\u8bdd</th><th>\u5f02\u5e38\u884c\u4e3a</th><th>\u5269\u4f59/\u6700\u8fd1</th><th>\u8bbe\u5907</th></tr></thead><tbody>{customer_rows_html}</tbody></table></div>{customer_page_nav}
        <h2>\u5f3a\u5236\u4e0b\u7ebf</h2>
        <form class="compact-form mini" method="post" action="/admin/customers/offline">
          <label>\u7535\u8bdd\u6216 IP</label><input name="target" placeholder="\u586b\u5199\u7535\u8bdd\u53f7\u7801\u6216 IP\uff0c\u4f8b\u5982 13800000000 / 1.2.3.4" required>
          <label>\u4e0b\u7ebf\u65f6\u95f4</label><select name="duration"><option value="3d">3\u5929</option><option value="7d">7\u5929</option><option value="1m">1\u4e2a\u6708</option><option value="permanent">\u6c38\u4e45</option></select>
          <div class="actions"><button class="btn danger" type="submit">\u5f3a\u5236\u4e0b\u7ebf\u5e76\u653e\u5165\u5c0f\u9ed1\u5c4b</button></div>
        </form>
        <h2>\u5c0f\u9ed1\u5c4b\u540d\u5355</h2>
        <div class="module-scroll"><table><thead><tr><th>\u72b6\u6001</th><th>IP</th><th>\u59d3\u540d/\u8d26\u53f7</th><th>\u7535\u8bdd</th><th>\u65f6\u957f</th><th>\u5230\u671f</th><th>\u539f\u56e0</th><th>\u64cd\u4f5c</th></tr></thead><tbody>{blacklist_rows_html}</tbody></table></div>
      </div>

      <div class="card module-card" data-module="codes" data-recycle-action="/admin/codes/recycle">
        <h2>4. 永久兑换码模块 <span>可用 {code_available}</span></h2>
        <div class="kpi-row">
          <div class="kpi"><span>兑换码总数</span><b>{code_total}</b></div>
          <div class="kpi"><span>已兑换</span><b>{code_redeemed}</b></div>
        </div>
        <p class="muted">卡密玩法已取消，这里只生成永久兑换码，用于管理员人工发放。</p>
        <form class="compact-form" method="post" action="/admin/codes/create">
          <label>兑换码类型</label><select name="plan">{plan_options}</select>
          <label>生成数量</label><input name="count" type="number" min="1" max="200" value="1">
          <label>备注</label><input name="note" placeholder="例如 老客户补发 / 内测用户">
          <div class="actions"><button class="btn" type="submit">生成永久兑换码</button></div>
        </form>
        <div class="module-scroll"><table><thead><tr><th>\u5151\u6362\u7801</th><th>\u72b6\u6001</th><th>\u59d3\u540d</th><th>\u7535\u8bdd</th><th>\u751f\u6210\u65f6\u95f4</th><th>\u64cd\u4f5c</th></tr></thead><tbody>{code_rows_html}</tbody></table></div>
      </div>
      <div class="card module-card" data-module="programmers">
        <h2>5. 程序员管理 <span>仅版本更新权限</span></h2>
        <p class="muted">这里发放程序员子账号。程序员登录后只能看到版本更新，只能上传版本；管理员可以随时收回账号。</p>
        <form class="compact-form" method="post" action="/admin/programmers/create">
          <label>程序员账号</label><input name="username" placeholder="例如 dev01" required>
          <label>初始密码</label><input name="password" type="text" placeholder="给程序员的登录密码" required>
          <label>备注</label><input name="note" placeholder="例如 外包前端 / 临时版本更新">
          <div class="actions"><button class="btn" type="submit">创建/重置程序员账号</button></div>
        </form>
        <div class="module-scroll"><table><thead><tr><th>账号</th><th>权限</th><th>状态</th><th>备注</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{programmer_rows_html}</tbody></table></div>
      </div>
      </section>
    </section>
  </main>
<script>
(function () {{
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.module-switch'));
  var modules = Array.prototype.slice.call(document.querySelectorAll('.module-card[data-module]'));
  var storageKey = 'baiqiuAdminModule';
  function activate(name) {{
    var exists = modules.some(function (item) {{ return item.getAttribute('data-module') === name; }});
    if (!exists) name = 'accounting';
    buttons.forEach(function (btn) {{
      btn.classList.toggle('active', btn.getAttribute('data-module-target') === name);
    }});
    modules.forEach(function (card) {{
      card.classList.toggle('active', card.getAttribute('data-module') === name);
    }});
    try {{ localStorage.setItem(storageKey, name); }} catch (e) {{}}
  }}
  buttons.forEach(function (btn) {{
    btn.addEventListener('click', function () {{
      activate(btn.getAttribute('data-module-target'));
    }});
  }});
  try {{ activate(localStorage.getItem(storageKey) || 'accounting'); }} catch (e) {{ activate('version'); }}
}})();
</script>
</body>
</html>"""


admin_dashboard = admin_dashboard_v2


class Handler(BaseHTTPRequestHandler):
    server_version = "BaiqiuUpdateServer/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.end_headers()

    def do_HEAD(self):
        track_online_client(self)
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/assets/baiqiu-icon.png":
            return self.send_file(ASSETS / "baiqiu-icon.png", download_name="baiqiu-icon.png", head_only=True, inline=True)
        if path in ("/admin", "/admin/"):
            data = admin_login_page().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return
        if path in ("/", "/client", "/download"):
            data = download_page(self).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return
        if path.startswith("/download/") and path.endswith("-setup.exe"):
            version = unquote(Path(path).name.removeprefix("baiqiu-").removesuffix("-setup.exe"))
            manifest = read_json(MANIFEST, {"channels": {"stable": []}})
            for item in manifest.get("channels", {}).get("stable", []):
                if str(item.get("version")) == version and item.get("installerFile"):
                    return self.send_file(RELEASES / item["installerFile"], download_name=f"BaiqiuAI-Setup-{version}.exe", head_only=True)
            self.send_response(404)
            self.end_headers()
            return
        direct_zip = path.strip("/")
        if direct_zip.startswith("baiqiu-") and direct_zip.endswith(".zip"):
            version = unquote(direct_zip[len("baiqiu-"):-len(".zip")])
            manifest = read_json(MANIFEST, {"channels": {"stable": []}})
            for item in manifest.get("channels", {}).get("stable", []):
                if str(item.get("version")) == version:
                    return self.send_release_zip(item, head_only=True)
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        track_online_client(self)
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        origin = public_origin(self)

        if path == "/assets/baiqiu-icon.png":
            return self.send_file(ASSETS / "baiqiu-icon.png", download_name="baiqiu-icon.png", inline=True)

        if path in ("/admin", "/admin/"):
            if not is_admin_authenticated(self):
                return send_html(self, admin_login_page())
            return send_html(self, admin_dashboard(self))

        if path in ("/", "/client", "/download"):
            return send_html(self, download_page(self))

        if path == "/buy":
            plan_key = query.get("plan", ["monthly"])[0]
            return send_html(self, buy_page(self, plan_key))

        if path == "/health":
            return write_json_response(self, {"ok": True, "service": "Baiqiu update server", "root": str(ROOT)})

        if path == "/api/plans":
            data = read_license_store()
            return write_json_response(self, {"ok": True, "plans": data.get("plans", {})})

        if path == "/api/developer/status":
            return write_json_response(self, developer_status_payload())

        if path == "/api/order/status":
            try:
                result = paid_order_status(
                    query.get("orderId", [""])[0],
                    query.get("deviceId", [""])[0],
                )
                return write_json_response(self, {"ok": True, "order": result})
            except Exception as exc:
                return write_json_response(self, {"ok": False, "message": str(exc)}, 400)

        if path == "/api/latest":
            return write_json_response(self, latest_payload(self, query.get("channel", ["stable"])[0]))

        if path == "/update.json":
            signed_manifest_path = ROOT / "update.json"
            try:
                signed_manifest = json.loads(signed_manifest_path.read_text("utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                return write_json_response(self, {"error": "Signed update manifest unavailable"}, 503)
            return write_json_response(self, signed_manifest)

        if path in ("/manifest.json", "/baiqiu-update.json"):
            return write_json_response(self, latest_payload(self, query.get("channel", ["stable"])[0]))

        if path == "/api/update/check":
            current_version = query.get("version", ["0.0.0"])[0]
            channel = query.get("channel", ["stable"])[0]
            release = latest_release(channel)
            if not release:
                return write_json_response(self, {"hasUpdate": False, "latestVersion": current_version, "message": "暂无更新"})
            version = str(release.get("version"))
            file_path = release_file(release)
            has_update = version_key(version) > version_key(current_version)
            return write_json_response(self, {
                "hasUpdate": has_update,
                "latestVersion": version,
                "releaseNotes": release.get("notes") or "",
                "downloadUrl": f"{origin}/api/update/download?channel={quote(channel)}&version={quote(version)}",
                "fileSize": file_path.stat().st_size if file_path and file_path.exists() else 0,
                "checksum": release.get("sha256") or (sha256_file(file_path) if file_path and file_path.exists() else ""),
            })

        if path == "/api/update/download":
            channel = query.get("channel", ["stable"])[0]
            release = latest_release(channel)
            return self.send_release_zip(release)

        direct_zip = path.strip("/")
        if direct_zip.startswith("baiqiu-") and direct_zip.endswith(".zip"):
            version = unquote(direct_zip[len("baiqiu-"):-len(".zip")])
            manifest = read_json(MANIFEST, {"channels": {"stable": []}})
            for item in manifest.get("channels", {}).get("stable", []):
                if str(item.get("version")) == version:
                    return self.send_release_zip(item)
            return write_json_response(self, {"message": "暂无更新包"}, 404)

        if path.startswith("/download/") and path.endswith("-setup.exe"):
            version = unquote(Path(path).name.removeprefix("baiqiu-").removesuffix("-setup.exe"))
            manifest = read_json(MANIFEST, {"channels": {"stable": []}})
            for item in manifest.get("channels", {}).get("stable", []):
                if str(item.get("version")) == version and item.get("installerFile"):
                    return self.send_file(RELEASES / item["installerFile"], download_name=f"BaiqiuAI-Setup-{version}.exe")
            return write_json_response(self, {"message": "安装包不存在"}, 404)

        return write_json_response(self, {"message": "Not found"}, 404)

    def do_POST(self):
        track_online_client(self)
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/buy":
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            plan_key = (form.get("plan") or ["monthly"])[0]
            customer = (form.get("customer") or [""])[0]
            try:
                order = create_order(plan_key, customer)
                return send_html(self, simple_result_page(
                    "订单已创建",
                    f"订单 {order['orderId']} 已创建，套餐 {order['planName']}，首次折扣价 ¥{order['firstPrice']}。正式支付通道接入后这里会跳转收款。",
                    [("/", "返回客户下载页"), ("/admin", "进入管理后台")]
                ))
            except Exception as exc:
                return send_html(self, buy_page(self, plan_key, str(exc)), 400)

        if path == "/redeem":
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            code = (form.get("code") or [""])[0]
            customer = (form.get("customer") or [""])[0]
            try:
                phone = (form.get("phone") or [""])[0]
                result = redeem_code(code, customer, phone)
                valid_text = "永久有效" if result.get("lifetime") else f"有效期至 {result.get('expiresAt')}"
                return send_html(self, simple_result_page("兑换成功", f"已兑换 {result.get('planName')}，{valid_text}。"))
            except Exception as exc:
                return send_html(self, simple_result_page("兑换失败", str(exc)), 400)

        if path == "/api/redeem":
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            try:
                if "application/json" in (self.headers.get("Content-Type") or ""):
                    payload = json.loads(raw or "{}")
                else:
                    form = parse_qs(raw)
                    payload = {key: values[0] if values else "" for key, values in form.items()}
                result = redeem_code(payload.get("code", ""), payload.get("customer") or payload.get("name") or payload.get("deviceId") or "", payload.get("phone", ""))
                return write_json_response(self, {"ok": True, "license": result})
            except Exception as exc:
                return write_json_response(self, {"ok": False, "message": str(exc)}, 400)

        if path == "/api/order/create":
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            try:
                if "application/json" in (self.headers.get("Content-Type") or ""):
                    payload = json.loads(raw or "{}")
                else:
                    form = parse_qs(raw)
                    payload = {key: values[0] if values else "" for key, values in form.items()}
                order = create_paid_order(
                    payload.get("plan", "monthly"),
                    payload.get("customer", ""),
                    payload.get("deviceId", ""),
                    payload.get("paymentMethod", "wechat"),
                    payload.get("phone", ""),
                )
                return write_json_response(self, {"ok": True, "order": order})
            except Exception as exc:
                return write_json_response(self, {"ok": False, "message": str(exc)}, 400)

        if path == "/admin/login":
            length = int(self.headers.get("Content-Length") or "0")
            if length > 64 * 1024:
                return send_html(self, admin_login_page("登录请求过大"), 413)
            body = self.rfile.read(length).decode("utf-8", errors="replace")
            form = parse_qs(body)
            username = (form.get("username") or ["admin"])[0]
            password = (form.get("password") or [""])[0]
            auth = authenticate_admin_login(username, password)
            if auth:
                return redirect(self, "/admin", make_role_session_cookie(auth["role"], auth["username"]))
            return send_html(self, admin_login_page("账号或密码不正确"), 401)

        if path == "/admin/logout":
            return redirect(self, "/admin", clear_session_cookie())

        if path == "/admin/orders/approve":
            if not require_admin(self):
                return send_html(self, admin_login_page("请先登录"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            try:
                order = approve_paid_order((form.get("orderId") or [""])[0])
                return send_html(self, admin_dashboard(self, message=f"已确认付款并发放会员：{order.get('orderId')}，有效期至 {order.get('expiresAt')}"))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        if path == "/admin/accounting/add":
            if not require_admin(self):
                return send_html(self, admin_login_page("请先登录"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            try:
                entry = add_accounting_entry(
                    (form.get("kind") or ["income"])[0],
                    (form.get("amount") or [""])[0],
                    (form.get("category") or ["其他"])[0],
                    (form.get("method") or ["其他"])[0],
                    (form.get("note") or [""])[0],
                    (form.get("date") or [""])[0],
                )
                kind_label = "收入" if entry.get("kind") == "income" else "支出"
                return send_html(self, admin_dashboard(self, message=f"已保存记账：{kind_label} ¥{entry['amount']:.2f}"))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        if path == "/admin/codes/create":
            if not require_admin(self):
                return send_html(self, admin_login_page("请先登录"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            try:
                count = int((form.get("count") or ["1"])[0] or "1")
            except Exception:
                count = 1
            note = (form.get("note") or [""])[0]
            plan = (form.get("plan") or ["redeem_lifetime"])[0]
            if plan not in ("redeem_lifetime", "monthly", "weekly", "six_months"):
                plan = "redeem_lifetime"
            created = generate_redeem_codes(plan, count, note)
            codes = "，".join(item["code"] for item in created[:5])
            more = " 等" if len(created) > 5 else ""
            return send_html(self, admin_dashboard(self, message=f"已生成 {len(created)} 个永久兑换码：{codes}{more}"))

        if path == "/admin/codes/recycle":
            if not require_admin(self):
                return send_html(self, admin_login_page("????"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            try:
                item = recycle_redeem_code((form.get("code") or [""])[0])
                return send_html(self, admin_dashboard(self, message=f"???????{item.get('code')}"))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        if path == "/admin/customers/offline":
            if not require_admin(self):
                return send_html(self, admin_login_page("????"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            target = (form.get("target") or form.get("ip") or form.get("phone") or [""])[0].strip()
            duration = (form.get("duration") or ["permanent"])[0]
            ip = target if "." in target or ":" in target else ""
            phone = "" if ip else target
            try:
                existed, item = force_offline(ip=ip, phone=phone, duration=duration)
                msg = f"????????????{target}??? {item.get('durationLabel', '??')}"
                return send_html(self, admin_dashboard(self, message=msg))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        if path == "/admin/customers/ban":
            if not require_admin(self):
                return send_html(self, admin_login_page("????"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            item = add_to_blacklist(
                (form.get("ip") or [""])[0],
                (form.get("name") or [""])[0],
                (form.get("phone") or [""])[0],
                (form.get("deviceId") or [""])[0],
                (form.get("reason") or ["????????????????"])[0],
                (form.get("duration") or ["permanent"])[0],
            )
            return send_html(self, admin_dashboard(self, message=f"????????????{item.get('name') or item.get('ip') or item.get('phone') or item.get('deviceId')}"))

        if path == "/admin/blacklist/release":
            if not require_admin(self):
                return send_html(self, admin_login_page("????"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            item = release_blacklist_item((form.get("id") or [""])[0])
            return send_html(self, admin_dashboard(self, message=f"???????{item.get('name') or item.get('ip') or item.get('phone') or item.get('id')}"))

        if path == "/admin/programmers/create":
            if not require_admin(self):
                return send_html(self, admin_login_page("????"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            try:
                user = create_programmer_account((form.get("username") or [""])[0], (form.get("password") or [""])[0], (form.get("note") or [""])[0])
                return send_html(self, admin_dashboard(self, message=f"???/????????{user.get('username')}"))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        if path == "/admin/programmers/revoke":
            if not require_admin(self):
                return send_html(self, admin_login_page("????"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(min(length, 64 * 1024)).decode("utf-8", errors="replace")
            form = parse_qs(body)
            try:
                user = revoke_programmer_account((form.get("username") or [""])[0])
                return send_html(self, admin_dashboard(self, message=f"?????????{user.get('username')}"))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        if path == "/admin/upload":
            if not is_admin_authenticated(self):
                return send_html(self, admin_login_page("请先登录"), 401)
            length = int(self.headers.get("Content-Length") or "0")
            if length <= 0:
                return send_html(self, admin_dashboard(self, error="没有收到上传内容"), 400)
            if length > MAX_UPLOAD_BYTES:
                return send_html(self, admin_dashboard(self, error=f"上传文件太大，最大允许 {human_size(MAX_UPLOAD_BYTES)}"), 413)
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                return send_html(self, admin_dashboard(self, error="请使用表单上传文件"), 400)
            try:
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": content_type,
                        "CONTENT_LENGTH": str(length),
                    },
                    keep_blank_values=True,
                )
                auth = current_auth(self) or {"username": "???"}
                item = publish_release_from_form(form, auth.get("username", "???"))
                return send_html(self, admin_dashboard(self, message=f"已发布白球 AI v{item['version']}"))
            except Exception as exc:
                return send_html(self, admin_dashboard(self, error=str(exc)), 400)

        return write_json_response(self, {"message": "Not found"}, 404)

    def send_release_zip(self, release, head_only=False):
        path = release_file(release)
        if not path or not path.exists():
            return write_json_response(self, {"message": "更新包不存在"}, 404)
        return self.send_file(path, download_name=f"baiqiu-{release.get('version')}.zip", head_only=head_only)

    def send_file(self, path, download_name=None, head_only=False, inline=False):
        path = Path(path).resolve()
        if not path.exists() or not path.is_file() or (RELEASES not in path.parents and ASSETS not in path.parents):
            return write_json_response(self, {"message": "文件不存在"}, 404)
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(path.stat().st_size))
        disposition = "inline" if inline else "attachment"
        self.send_header("Content-Disposition", f'{disposition}; filename="{download_name or path.name}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if head_only:
            return
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                self.wfile.write(chunk)


def main():
    RELEASES.mkdir(parents=True, exist_ok=True)
    if not MANIFEST.exists():
        MANIFEST.write_text(json.dumps({"channels": {"stable": []}}, ensure_ascii=False, indent=2), "utf-8")
    if not LICENSES.exists():
        write_license_store(default_license_store())
    if not ACCOUNTING.exists():
        write_accounting_store(default_accounting_store())
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[BaiqiuUpdateServer] listening on {HOST}:{PORT}, root={ROOT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
米游社二次元游戏限时兑换码 —— 自动发布脚本
=====================================================================
读取 NEWCODES.json（高置信候选码），注入两处本地源：
  1) server.js 的 SEED_CODES[game]
  2) index.html 的 window.__SEED__.games[game].codes
（并顺带同步 data/data.json，保证 /api/data 立即一致）
随后经 GitHub Contents API 推送改动，触发 Railway 重建 + Pages build。

置信度规则由调用方（猎手自动化）把关：本脚本只负责「注入 + 去重 + 部署」，
不判断来源可信度。已存在的 code（按字符串去重）会被跳过。

用法：
  python auto_publish_codes.py NEWCODES.json
  python auto_publish_codes.py NEWCODES.json --dry-run   # 只注入不推送
  python auto_publish_codes.py --self-test               # 用临时副本自测注入逻辑
"""
import json
import os
import re
import sys
import base64
import subprocess
import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = "roseion/mihoyo-codes"
API = f"https://api.github.com/repos/{REPO}/contents"

VALID_GAMES = {"genshin", "sr", "zzz", "wuwa", "endfield", "yuhuan"}

# 注入的字段顺序（server.js 用 JS 对象；index.html 用 JSON）
FIELDS = ["code", "reward", "published", "publishedAt", "location", "expires", "source", "reliable"]


def now_iso():
    return datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")


# ---------- token ----------
def get_token():
    try:
        url = subprocess.check_output(
            ["git", "-C", BASE, "config", "--get", "remote.origin.url"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        m = re.search(r"x-access-token:(.*)@", url)
        if m:
            return m.group(1)
    except Exception:
        pass
    return os.environ.get("GH_TOKEN")


# ---------- 括号感知匹配 ----------
def find_matching_bracket(s, pos):
    """s[pos] 必须是 '['，返回与之匹配的 ']' 下标（忽略字符串内括号）。"""
    assert s[pos] == "["
    depth = 0
    i = pos
    in_str = False
    quote = ""
    while i < len(s):
        c = s[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                in_str = False
        else:
            if c in ('"', "'"):
                in_str = True
                quote = c
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def find_matching_generic(s, pos):
    """s[pos] 必须是 '{' 或 '['，返回匹配的闭括号下标（忽略字符串内括号）。"""
    open_ch = s[pos]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    i = pos
    in_str = False
    quote = ""
    while i < len(s):
        c = s[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                in_str = False
        else:
            if c in ('"', "'"):
                in_str = True
                quote = c
            elif c in ("[", "{"):
                depth += 1
            elif c in ("]", "}"):
                depth -= 1
                if depth == 0 and c == close_ch:
                    return i
        i += 1
    return -1


# ---------- 提取已有 code ----------
def existing_codes_in_array(s, arr_start, arr_end):
    """从数组文本片段提取所有 code 字符串（兼容 'code:' 与 "code": 两种写法）。"""
    seg = s[arr_start + 1:arr_end]
    return set(re.findall(r"code[\"']?\s*[:=]\s*[\"']([^\"']+)[\"']", seg))


# ---------- 生成新条目文本 ----------
def js_obj_text(entry, indent=4):
    pad = " " * indent
    lines = ["{"]
    for f in FIELDS:
        if f not in entry:
            continue
        v = entry[f]
        if f == "reliable":
            val = "true" if v else "false"
        else:
            val = "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"
        lines.append(f"{pad}{f}: {val},")
    lines.append(" " * (indent - 2) + "},")
    return "\n".join(lines)


def json_obj_text(entry, indent=6):
    pad = " " * indent
    obj = {f: entry[f] for f in FIELDS if f in entry}
    # json.dumps 已处理转义
    dumped = json.dumps(obj, ensure_ascii=False)
    # 重新缩进
    parsed = json.loads(dumped)
    lines = ["{"]
    for f in FIELDS:
        if f not in parsed:
            continue
        v = parsed[f]
        if isinstance(v, bool):
            val = "true" if v else "false"
        else:
            val = json.dumps(v, ensure_ascii=False)
        lines.append(f"{pad}\"{f}\": {val},")
    lines.append(" " * (indent - 2) + "},")
    return "\n".join(lines)


# ---------- 注入 server.js ----------
def inject_server_js(text, game, new_entries):
    if f"\n  {game}:" not in text:
        raise RuntimeError(f"server.js 中未找到 SEED_CODES 游戏键: {game}")
    m = re.search(r"\n  " + re.escape(game) + r":", text)
    bracket_pos = text.find("[", m.end())
    arr_end = find_matching_bracket(text, bracket_pos)
    existing = existing_codes_in_array(text, bracket_pos, arr_end)
    to_add = [e for e in new_entries if e["code"] not in existing]
    if not to_add:
        return text, []
    block = "\n".join(js_obj_text(e) for e in to_add)
    # 在 '[' 之后插入
    new_text = text[: bracket_pos + 1] + "\n" + block + text[bracket_pos + 1:]
    return new_text, to_add


# ---------- 注入 index.html ----------
def inject_index_html(text, game, new_entries):
    slug_pos = text.find(f'"slug": "{game}"')
    if slug_pos < 0:
        raise RuntimeError(f"index.html __SEED__ 中未找到游戏 slug: {game}")
    codes_pos = text.find('"codes": [', slug_pos)
    if codes_pos < 0:
        raise RuntimeError(f"index.html __SEED__ 中未找到 {game} 的 codes 数组")
    bracket_pos = codes_pos + len('"codes": [') - 1
    arr_end = find_matching_bracket(text, bracket_pos)
    existing = existing_codes_in_array(text, bracket_pos, arr_end)
    to_add = [e for e in new_entries if e["code"] not in existing]
    if not to_add:
        return text, []
    block = "\n".join(json_obj_text(e) for e in to_add)
    new_text = text[: bracket_pos + 1] + "\n" + block + text[bracket_pos + 1:]
    # 更新 meta.updatedAt
    new_text = re.sub(
        r'("updatedAt"\s*:\s*")[^"]*(")',
        lambda mm: mm.group(1) + now_iso() + mm.group(2),
        new_text,
        count=1,
    )
    return new_text, to_add


# ---------- 注入 data/data.json ----------
def inject_data_json(text, game, new_entries):
    try:
        data = json.loads(text)
    except Exception:
        return text, []
    games = data.setdefault("games", {})
    g = games.setdefault(game, {})
    codes = g.setdefault("codes", [])
    existing = {c.get("code") for c in codes}
    to_add = [e for e in new_entries if e["code"] not in existing]
    if not to_add:
        return text, []
    for e in to_add:
        codes.append({f: e[f] for f in FIELDS if f in e})
    data["meta"] = data.get("meta", {})
    data["meta"]["updatedAt"] = now_iso()
    data["meta"]["mode"] = "seed"
    return json.dumps(data, ensure_ascii=False, indent=2), to_add


# ---------- GitHub Contents API ----------
def push_file(rel, content_text, token):
    url = f"{API}/{rel}"
    req = urllib_request_get(url, token)
    sha = None
    if req.get("sha"):
        sha = req["sha"]
    body = {
        "message": f"codes-hunter: add limited-time codes ({rel})",
        "content": base64.b64encode(content_text.encode("utf-8")).decode("ascii"),
    }
    if sha:
        body["sha"] = sha
    data = json.dumps(body).encode("utf-8")
    req2 = urllib_request_put(url, token, data)
    return req2


def urllib_request_get(url, token):
    import urllib.request
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise


def urllib_request_put(url, token, data):
    import urllib.request
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def trigger_pages_build(token):
    import urllib.request
    url = f"https://api.github.com/repos/{REPO}/pages/builds"
    req = urllib.request.Request(url, data=b"{}", method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except Exception as e:
        return f"ERR:{e}"


# ---------- 主流程 ----------
def main():
    args = sys.argv[1:]
    if not args:
        print("用法: python auto_publish_codes.py NEWCODES.json [--dry-run]")
        sys.exit(2)

    token = get_token()
    dry_run = "--dry-run" in args
    self_test = "--self-test" in args

    if self_test:
        run_self_test()
        return

    newcodes_path = args[0]
    with open(newcodes_path, "r", encoding="utf-8") as f:
        newcodes = json.load(f)
    if not isinstance(newcodes, list):
        newcodes = [newcodes]

    # 按 game 分组
    by_game = {}
    for e in newcodes:
        g = e.get("game")
        if g not in VALID_GAMES:
            print(f"[跳过] 未知游戏: {g} (code={e.get('code')})")
            continue
        if not e.get("code") or not e.get("expires"):
            print(f"[跳过] 缺 code 或 expires: {e}")
            continue
        by_game.setdefault(g, []).append(e)

    if not by_game:
        print("没有需要发布的高置信码。")
        sys.exit(0)

    # 注入 server.js
    srv = read_local("server.js")
    srv_changed = {}
    for g, entries in by_game.items():
        srv, added = inject_server_js(srv, g, entries)
        if added:
            srv_changed[g] = added

    # 注入 index.html
    idx = read_local("index.html")
    idx_changed = {}
    for g, entries in by_game.items():
        # 用原始 by_game（server 已去重，但 index 独立去重即可）
        idx, added = inject_index_html(idx, g, entries)
        if added:
            idx_changed[g] = added

    # 注入 data/data.json（若本地存在）
    data_changed = {}
    data_rel = "data/data.json"
    if os.path.exists(os.path.join(BASE, data_rel)):
        dt = read_local(data_rel)
        for g, entries in by_game.items():
            dt, added = inject_data_json(dt, g, entries)
            if added:
                data_changed[g] = added

    if not (srv_changed or idx_changed or data_changed):
        print("全部候选码已存在于种子中，无需发布。")
        sys.exit(0)

    # 汇总
    print("=== 待发布汇总 ===")
    for g in by_game:
        added = set()
        for d in (srv_changed.get(g), idx_changed.get(g), data_changed.get(g)):
            if d:
                added |= {e["code"] for e in d}
        if added:
            print(f"  [{g}] 新增: {', '.join(sorted(added))}")

    if dry_run:
        print("[DRY-RUN] 不推送。server.js 前 200 字符预览:")
        print(srv[:200])
        return

    if not token:
        print("未找到 GitHub token，无法推送。请设置 GH_TOKEN 或配置 git remote。")
        sys.exit(1)

    # 写回本地
    write_local("server.js", srv)
    write_local("index.html", idx)
    if data_changed:
        write_local(data_rel, dt)

    # 推送
    pushes = []
    if srv_changed:
        pushes.append("server.js")
    if idx_changed:
        pushes.append("index.html")
    if data_changed:
        pushes.append(data_rel)

    for rel in pushes:
        print(f"推送 {rel} ...", end=" ")
        res = push_file(rel, read_local(rel), token)
        print("ok" if res else "FAIL")

    print("触发 Pages build ...", trigger_pages_build(token))
    print("完成。Railway 将在下次构建时从 SEED_CODES 重新生成 data.json。")


def read_local(rel):
    with open(os.path.join(BASE, rel), "r", encoding="utf-8") as f:
        return f.read()


def write_local(rel, text):
    with open(os.path.join(BASE, rel), "w", encoding="utf-8") as f:
        f.write(text)


def run_self_test():
    """用临时副本验证注入逻辑不破坏结构（node 实际求值校验）。"""
    import shutil
    import subprocess
    tmp = os.path.join(BASE, "_selftest_tmp")
    os.makedirs(tmp, exist_ok=True)
    node = os.environ.get("NODE_BIN") or shutil.which("node") or \
        r"C:\Users\eosin\.workbuddy\binaries\node\versions\22.22.2\node.exe"

    sample = [
        {"game": "wuwa", "code": "TESTCODE123", "reward": "星声×100（自测）",
         "published": "2026-07-31", "publishedAt": "2026-07-31", "location": "测试",
         "expires": "2026-08-03 12:00:00", "source": "self-test", "reliable": True},
        {"game": "endfield", "code": "ENDTEST99", "reward": "测试奖励",
         "published": "2026-07-31", "publishedAt": "2026-07-31", "location": "测试",
         "expires": "2026-08-03 12:00:00", "source": "self-test", "reliable": True},
    ]
    srv_src = read_local("server.js")
    idx_src = read_local("index.html")
    srv2 = srv_src
    for e in sample:
        srv2, added = inject_server_js(srv2, e["game"], [e])
        assert added, f"server.js 注入失败: {e['game']}"
    idx2 = idx_src
    for e in sample:
        idx2, added = inject_index_html(idx2, e["game"], [e])
        assert added, f"index.html 注入失败: {e['game']}"

    # 提取 server.js 的 SEED_CODES 对象与 index.html 的 __SEED__ 对象，用 node 求值
    def extract_object(text, marker):
        p = text.find(marker)
        assert p >= 0, f"未找到标记: {marker}"
        obj_start = text.find("{", p)
        obj_end = find_matching_generic(text, obj_start)
        assert obj_end > 0, "未找到匹配闭括号"
        return text[obj_start: obj_end + 1]

    srv_obj = extract_object(srv2, "const SEED_CODES =")
    idx_obj = extract_object(idx2, "window.__SEED__ =")

    js_file = os.path.join(tmp, "eval.js")
    with open(js_file, "w", encoding="utf-8") as f:
        f.write("const SEED_CODES = " + srv_obj + ";\n")
        f.write("const __SEED__ = " + idx_obj + ";\n")
        f.write("console.log('OK', "
                "Object.keys(SEED_CODES).join(','), "
                "Object.keys(__SEED__.games).join(','));\n")

    out = subprocess.run([node, js_file], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"node 求值失败: {out.stderr[:300]}"
    assert out.stdout.strip().startswith("OK"), f"node 未正常输出: {out.stdout[:200]}"
    # 文本层面确认新码已写入
    for e in sample:
        assert e["code"] in srv2, f"server.js 缺少 {e['code']}"
        assert e["code"] in idx2, f"index.html 缺少 {e['code']}"

    # 验证去重：再次注入应跳过
    srv3, added = inject_server_js(srv2, "wuwa", [sample[0]])
    assert not added, "去重逻辑失效"
    idx3, added = inject_index_html(idx2, "wuwa", [sample[0]])
    assert not added, "index.html 去重逻辑失效"
    print("SELF-TEST PASS: server.js / index.html 注入 + 去重 + node 求值校验均通过。")
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()

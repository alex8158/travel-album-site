#!/usr/bin/env python3
"""
为每个 spec 生成 需求/设计/任务 对齐矩阵 (traceability.md)。

数据全部从 spec 的三份文档中提取，不推断、不猜测：
  - requirements.md  → 需求编号、标题、验收标准条数
  - tasks.md         → 任务树、勾选状态、可选标记、_Requirements: 反向引用
  - design.md        → 章节清单 + `**Validates:` / `**验证需求：` 需求引用

需求↔任务映射来源于 tasks.md 里的 _Requirements: 标注。
设计↔需求映射来源于 design.md 里的 `**Validates: ...**` / `**验证需求：...**` 标注
（不含 `_Requirements:_` —— 那是 tasks.md 的实现引用语法）。tasks 与 design 的引用
都参与越界校验。

用法: python3 .kiro/specs/_gen_traceability.py
"""
import io
import os
import re
import sys

SPECS_DIR = os.path.dirname(os.path.abspath(__file__))

# 以路径直接运行时（python3 .kiro/specs/_gen_traceability.py），脚本所在目录已在
# sys.path 首位；从其他工作目录 import 时补一次，确保能取到同目录的 _spec_parse。
if SPECS_DIR not in sys.path:
    sys.path.insert(0, SPECS_DIR)
import _spec_parse  # noqa: E402  （必须在 sys.path 调整之后）


def read(path):
    if not os.path.exists(path):
        return None
    return io.open(path, encoding='utf-8').read()


def write_atomic(path, content):
    """同目录临时文件 + os.replace，避免中途失败留下半写的正式产物。

    临时文件名以 `.` 开头并带 `.tmp` 后缀，正常路径下在 replace 时即消失；
    异常路径下会被清理，不会成为 git 候选。
    """
    d, base = os.path.dirname(path), os.path.basename(path)
    tmp = os.path.join(d, f'.{base}.tmp')
    try:
        with io.open(tmp, 'w', encoding='utf-8') as fh:
            fh.write(content)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# --------------------------------------------------------------------------
# 解析 requirements.md
# --------------------------------------------------------------------------

REQ_HEAD = re.compile(r'^#{2,3}\s+(?:Requirement|需求)\s*(\d+)\s*[:：]\s*(.+?)\s*$', re.M)
AC_HEAD = re.compile(r'^####\s+(?:Acceptance Criteria|验收标准)\s*$', re.M)


def parse_requirements(text):
    """返回 [(编号, 标题, 验收标准条数)]"""
    if not text:
        return []
    out = []
    heads = list(REQ_HEAD.finditer(text))
    for i, m in enumerate(heads):
        num = int(m.group(1))
        title = m.group(2).strip()
        start = m.end()
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[start:end]
        ac = AC_HEAD.search(body)
        count = 0
        if ac:
            after = body[ac.end():]
            # 截断到下一个 #### 小节
            nxt = re.search(r'^####\s', after, re.M)
            if nxt:
                after = after[:nxt.start()]
            nums = [int(x) for x in re.findall(r'^(\d+)\.\s', after, re.M)]
            count = max(nums) if nums else 0
        out.append((num, title, count))
    return out


# --------------------------------------------------------------------------
# 解析 tasks.md
# --------------------------------------------------------------------------

TASK_LINE = _spec_parse.TASK_LINE  # canonical 定义见 _spec_parse.py

# 需求反向引用。本仓库存在四种写法，全部需要支持：
#   _Requirements: 1.1, 1.2_        （英文，多数 spec）
#   _需求: 2.3, 2.4_                （中文半角冒号，hybrid-dedup）
#   _需求：R10-AC1_                 （中文全角冒号 + R-AC 格式，smart-video-editing）
#   _Requirements: R7-AC1_          （英文 + R-AC 格式，video-upload-pipeline）
REQ_REF = re.compile(r'_(?:Requirements?|需求)[:：]\s*(.+?)_')

# 测试任务与设计属性的验证标注。三种写法，全部需要支持：
#   **Validates: Requirements 1.1**   （英文，多数 spec）
#   **验证: 需求 2.3, 2.4**            （中文，hybrid-dedup）
#   **验证需求：R6-AC6**               （中文合写，smart-video-editing）
#
# `验证需求` 必须排在 `验证` 之前，否则短分支会先匹配成功并把 `需求` 留在冒号位置。
# 冒号约束必须保留：design.md 里的 `**验证逻辑**`、`**验证照片文件**` 是小节标签而非
# 追溯标记，放宽冒号会把它们误当引用。
VALIDATES = re.compile(
    r'\*\*(?:Validates?|验证需求|验证)[:：]\s*(?:Requirements?|需求)?\s*(.+?)\*\*'
)


def expand_refs(s):
    """把 '1.1, 2.1-2.5, 3.6–3.9, 1.Q1-1.Q4, R7-AC1' 展开成 {(req, crit_str)} 集合"""
    refs = set()
    # R{n}-AC{m} 格式（video-upload-pipeline 使用）
    for r, c in re.findall(r'R(\d+)\s*-\s*AC(\d+)', s):
        refs.add((int(r), str(int(c))))
    s = re.sub(r'R\d+\s*-\s*AC\d+', ' ', s)
    # Q 标签
    for r, q in re.findall(r'(\d+)\.Q(\d+)', s):
        refs.add((int(r), 'Q' + q))
    s2 = re.sub(r'\d+\.Q\d+', ' ', s)
    # 区间 a.b-c.d 或 a.b-d
    for m in re.finditer(r'(\d+)\.(\d+)\s*[-–]\s*(?:(\d+)\.)?(\d+)', s2):
        r1, c1, r2, c2 = m.group(1), m.group(2), m.group(3), m.group(4)
        r1, c1, c2 = int(r1), int(c1), int(c2)
        r2 = int(r2) if r2 else r1
        if r1 == r2 and c2 >= c1:
            for c in range(c1, c2 + 1):
                refs.add((r1, str(c)))
        else:
            refs.add((r1, str(c1)))
            refs.add((r2, str(c2)))
    s3 = re.sub(r'(\d+)\.(\d+)\s*[-–]\s*(?:(\d+)\.)?(\d+)', ' ', s2)
    # 单点
    for r, c in re.findall(r'(\d+)\.(\d+)', s3):
        refs.add((int(r), str(int(c))))
    return refs


def parse_tasks(text):
    """返回 [ {id, title, done, optional, depth, refs:set, validates:set} ]"""
    if not text:
        return []
    tasks = []
    cur = None
    for line in text.splitlines():
        m = TASK_LINE.match(line)
        if m:
            indent, mark, star, tid, title = m.groups()
            cur = {
                'id': tid,
                'title': title.strip(),
                'done': mark == 'x',
                'optional': star == '*',
                'depth': len(indent) // 2,
                'refs': set(),
                'validates': set(),
            }
            tasks.append(cur)
            continue
        if cur is None:
            continue
        mr = REQ_REF.search(line)
        if mr:
            cur['refs'] |= expand_refs(mr.group(1))
        mv = VALIDATES.search(line)
        if mv:
            cur['validates'] |= expand_refs(mv.group(1))
    return tasks


# --------------------------------------------------------------------------
# 解析 design.md
# --------------------------------------------------------------------------

def parse_design_sections(text):
    """返回 [(层级, 标题, 行号)]"""
    if not text:
        return []
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        m = re.match(r'^(#{2,3})\s+(.*?)\s*$', line)
        if m:
            out.append((len(m.group(1)), m.group(2), i))
    return out


def parse_design_refs(text):
    """design.md 的需求引用。

    只认 VALIDATES（`**Validates: ...**` / `**验证需求：...**`），不认 REQ_REF。
    authority 划分：REQ_REF 是「实现任务 → 需求」，属 tasks.md；VALIDATES 是
    「测试任务或设计属性 → 需求」，tasks.md 与 design.md 共用。实测 22 份 design.md
    中 REQ_REF 命中为 0，没有证据表明 design 使用该语法。

    返回 [ {ref:(req, crit), section:str, line:int, raw:str} ]，按出现顺序。
    """
    if not text:
        return []
    out = []
    section = None
    for i, line in enumerate(text.splitlines(), 1):
        h = re.match(r'^(#{2,3})\s+(.*?)\s*$', line)
        if h:
            section = h.group(2)
            continue
        m = VALIDATES.search(line)
        if not m:
            continue
        raw = m.group(0)
        for ref in sorted(expand_refs(m.group(1))):
            out.append({'ref': ref, 'section': section or '(文件开头)',
                        'line': i, 'raw': raw})
    return out


# --------------------------------------------------------------------------
# 生成
# --------------------------------------------------------------------------

def status_cell(t):
    if t['done']:
        return '✅ 完成'
    return '⬜ 可选，未做' if t['optional'] else '❌ 未完成'


def build(spec):
    d = os.path.join(SPECS_DIR, spec)
    req_text = read(os.path.join(d, 'requirements.md'))
    bug_text = read(os.path.join(d, 'bugfix.md'))
    design_text = read(os.path.join(d, 'design.md'))
    tasks_text = read(os.path.join(d, 'tasks.md'))

    reqs = parse_requirements(req_text)
    tasks = parse_tasks(tasks_text)
    sections = parse_design_sections(design_text)
    design_refs = parse_design_refs(design_text)

    # as-built spec：有需求文档但没有 tasks.md，说明是为既有实现事后补写的规格，
    # 本就不存在任务计划，不应报告为缺口。
    is_as_built = bool(reqs) and tasks_text is None

    req_counts = {n: c for n, _, c in reqs}

    # 需求 → 任务
    cover = {n: [] for n, _, _ in reqs}
    for t in tasks:
        hit = {r for r, _ in (t['refs'] | t['validates'])}
        for r in sorted(hit):
            if r in cover:
                cover[r].append(t)

    # 需求 → 设计章节（来自 design.md 的 VALIDATES 标注）。保持出现顺序，同一
    # (章节, 行) 只记一次。
    dcover = {n: [] for n, _, _ in reqs}
    for dr in design_refs:
        r = dr['ref'][0]
        if r in dcover:
            entry = (dr['section'], dr['line'])
            if entry not in dcover[r]:
                dcover[r].append(entry)

    # 越界引用（仅在存在编号需求时才有意义；bugfix 型 spec 的 X.Y 引用的是 bugfix.md 的 Bug 编号）
    def _range_issue(r, c):
        """越界原因，未越界返回 None。"""
        if c.startswith('Q'):
            return None
        if r not in req_counts:
            return '需求不存在'
        if req_counts[r] and int(c) > req_counts[r]:
            return f'需求 {r} 只有 {req_counts[r]} 条'
        return None

    out_of_range = []
    for t in (tasks if reqs else []):
        for r, c in sorted(t['refs'] | t['validates']):
            why = _range_issue(r, c)
            if why:
                out_of_range.append((f'tasks.md 任务 {t["id"]}', f'{r}.{c}', why))

    # design.md 的 VALIDATES 引用同样纳入越界校验：需求重编号后 design 的标注常被漏改。
    for dr in (design_refs if reqs else []):
        r, c = dr['ref']
        why = _range_issue(r, c)
        if why:
            out_of_range.append(
                (f'design.md L{dr["line"]}（{dr["section"]}）', f'{r}.{c}', why))

    # 叶子任务 = 没有任何其他任务以 "<id>." 为前缀的任务。
    # 只统计叶子，避免父任务与子任务重复计数；没有子项的顶层任务本身就是叶子。
    all_ids = [t['id'] for t in tasks]
    leaf = [t for t in tasks
            if not any(o != t['id'] and o.startswith(t['id'] + '.') for o in all_ids)]
    top = [t for t in tasks if '.' not in t['id']]
    countable = leaf
    must = [t for t in countable if not t['optional']]
    opt = [t for t in countable if t['optional']]
    must_done = [t for t in must if t['done']]
    opt_done = [t for t in opt if t['done']]

    L = []
    L.append(f'# 需求 / 设计 / 任务 对齐矩阵：{spec}')
    L.append('')
    L.append('> **自动生成，未经代码核对。**')
    L.append('>')
    L.append('> 本表由 `.kiro/specs/_gen_traceability.py` 从本 spec 的 requirements / design / tasks 三份文档提取生成。')
    L.append('> 它反映的是**文档之间**的对应关系与勾选状态，**没有**核对需求描述是否与当前代码一致。')
    L.append('>')
    L.append('> 对比参考：`photo-curation-fix/traceability-verified.md` 是人工逐条代码核对的版本。')
    L.append('> 若要把本表升级为已核实状态，需要逐需求比对实现，并在此处替换本提示。')
    L.append('')
    L.append('文档权威顺序见 `AGENTS.md` 第 5.1 节。需求以 `requirements.md` 为准，进度以 `tasks.md` 勾选状态为准。')
    L.append('')
    L.append('---')
    L.append('')

    # 概况
    L.append('## 一、概况')
    L.append('')
    L.append('| 项 | 值 |')
    L.append('| --- | --- |')
    if reqs:
        L.append(f'| 需求条目 | {len(reqs)} 条需求，合计 {sum(c for _, _, c in reqs)} 条验收标准 |')
    elif bug_text:
        L.append('| 需求条目 | 无编号需求（本 spec 使用 `bugfix.md` 描述问题与修复范围）|')
    else:
        L.append('| 需求条目 | 未找到 requirements.md |')
    L.append(f'| 设计章节 | {len(sections)} 个（见第三节）|')
    L.append(f'| 任务条目 | 共 {len(tasks)} 项（顶层 {len(top)} 项，其中叶子任务 {len(leaf)} 项参与完成度统计）|')
    L.append(f'| 必做任务完成度 | **{len(must_done)} / {len(must)}** |')
    L.append(f'| 可选任务完成度 | {len(opt_done)} / {len(opt)} |')
    if reqs and is_as_built:
        L.append('| 需求覆盖率 | 不适用 —— as-built 规格无任务计划，需求落实情况需直接对照代码核对 |')
    elif reqs:
        covered = sum(1 for n, _, _ in reqs if cover[n])
        note = ''
        if covered < len(reqs):
            note = '  ⚠️ 有需求未被任何任务引用，任务完成度不代表需求已全部落实'
        L.append(f'| 需求覆盖率 | {covered} / {len(reqs)} 条需求有任务引用{note} |')
    L.append('')
    if reqs and not is_as_built and sum(1 for n, _, _ in reqs if cover[n]) < len(reqs):
        L.append('> **注意**：任务完成度与需求覆盖率是两件事。任务可能 100% 完成，'
                 '同时仍有需求从未进入任务计划 —— 这类需求即使代码已实现，也没有任何任务或测试为其背书。')
        L.append('')

    # 总览
    L.append('## 二、需求 → 任务 对齐')
    L.append('')
    if not reqs:
        if bug_text:
            L.append('本 spec 没有编号需求文档，无法建立需求↔任务矩阵。问题描述与修复范围见 `bugfix.md`，任务清单见第四节。')
        else:
            L.append('未找到 `requirements.md`，无法建立需求↔任务矩阵。')
        L.append('')
    elif not any(cover.values()):
        if is_as_built:
            L.append('本 spec 是 **as-built 规格**：为既有实现事后补写，没有 `tasks.md`，因此不存在需求↔任务映射，'
                     '这是预期状态而非缺口。需求的落实情况应直接对照代码核对。')
        else:
            L.append('⚠️ **本 spec 的 `tasks.md` 没有任何需求引用标注**，因此无法自动建立需求↔任务映射。')
            L.append('')
            L.append('下表仅列出需求清单。要建立映射，需要为各任务补充 `_Requirements: X.Y_` 标注。')
        L.append('')
        L.append('| 需求 | 标题 | 验收标准条数 |')
        L.append('| --- | --- | --- |')
        for n, title, c in reqs:
            L.append(f'| {n} | {title} | {c} |')
        L.append('')
    else:
        L.append('| 需求 | 标题 | 验收标准条数 | 相关任务 | 必做完成度 |')
        L.append('| --- | --- | --- | --- | --- |')
        for n, title, c in reqs:
            ts = cover[n]
            if ts:
                ids = ', '.join(t['id'] + ('*' if t['optional'] else '') for t in ts)
                m = [t for t in ts if not t['optional']]
                md = [t for t in m if t['done']]
                frac = f'{len(md)} / {len(m)}' if m else '—（仅可选任务）'
            else:
                ids = '⚠️ 无任务引用'
                frac = '—'
            L.append(f'| {n} | {title} | {c} | {ids} | {frac} |')
        L.append('')
        gaps = [n for n, _, _ in reqs if not cover[n]]
        if gaps:
            L.append(f'⚠️ **无任务引用的需求**：{", ".join("需求 " + str(g) for g in gaps)}')
            L.append('')
            L.append('这可能意味着任务缺少 `_Requirements:` 标注，也可能意味着该需求确实没有对应任务。需人工确认。')
            L.append('')

    # 需求 ↔ 设计
    L.append('## 三、需求 → 设计 对齐')
    L.append('')
    if not sections:
        L.append('未找到 `design.md`。')
        L.append('')
    elif not design_refs:
        L.append('`design.md` 中没有 `**Validates: ...**` / `**验证需求：...**` 标注，'
                 '因此设计↔需求的对应关系无法自动建立。章节清单见下方附表。')
        L.append('')
    elif not reqs:
        L.append(f'`design.md` 中有 {len(design_refs)} 处验证标注，但本 spec 没有编号需求文档，'
                 '无法建立需求↔设计矩阵。章节清单见下方附表。')
        L.append('')
    else:
        L.append('映射来源是 `design.md` 里的 `**Validates: ...**` / `**验证需求：...**` 标注。')
        L.append('')
        L.append('| 需求 | 标题 | 设计章节（行号） |')
        L.append('| --- | --- | --- |')
        for n, title, _c in reqs:
            hits = dcover[n]
            cell = ('；'.join(f'{sec}（L{ln}）' for sec, ln in hits)
                    if hits else '⚠️ 无设计引用')
            L.append(f'| {n} | {title} | {cell} |')
        L.append('')
        dgaps = [n for n, _, _ in reqs if not dcover[n]]
        if dgaps:
            L.append(f'⚠️ **无设计引用的需求**：{", ".join("需求 " + str(g) for g in dgaps)}')
            L.append('')
            L.append('可能是 `design.md` 的验证标注缺失，也可能该需求确实没有对应设计章节。需人工确认。')
            L.append('')

    # 设计章节清单（附表）
    L.append('### 附：设计章节清单')
    L.append('')
    if not sections:
        L.append('未找到 `design.md`。')
    else:
        L.append('| 行号 | 层级 | 章节 |')
        L.append('| --- | --- | --- |')
        for lvl, title, ln in sections:
            L.append(f'| {ln} | {"##" if lvl == 2 else "###"} | {title} |')
    L.append('')

    # 任务明细
    L.append('## 四、任务明细')
    L.append('')
    if not tasks:
        L.append('未找到 `tasks.md` 或其中没有任务条目。')
    else:
        if not reqs and bug_text:
            L.append('本 spec 无编号需求，「引用」列中的编号指向 `bugfix.md` 里的 Bug 编号，不是需求编号。')
            L.append('')
        L.append('| 任务 | 描述 | 状态 | ' + ('引用需求' if reqs else '引用编号') + ' |')
        L.append('| --- | --- | --- | --- |')
        for t in tasks:
            refs = t['refs'] | t['validates']
            rs = ', '.join(f'{r}.{c}' for r, c in sorted(refs, key=lambda x: (x[0], str(x[1])))) or '—'
            indent = '　' * t['depth']
            title = t['title'].replace('|', '\\|')
            L.append(f'| {indent}{t["id"]}{"*" if t["optional"] else ""} | {title} | {status_cell(t)} | {rs} |')
    L.append('')

    # 未完成
    undone_must = [t for t in must if not t['done']]
    undone_opt = [t for t in opt if not t['done']]
    L.append('## 五、未完成任务')
    L.append('')
    if not undone_must and not undone_opt:
        L.append('全部任务已完成。')
    else:
        if undone_must:
            L.append('### 必做，未完成')
            L.append('')
            for t in undone_must:
                L.append(f'- **{t["id"]}** {t["title"]}')
            L.append('')
        if undone_opt:
            L.append('### 可选，未完成')
            L.append('')
            for t in undone_opt:
                L.append(f'- {t["id"]}* {t["title"]}')
            L.append('')
    L.append('')

    # 引用问题
    L.append('## 六、引用一致性')
    L.append('')
    if not reqs:
        L.append('无编号需求，跳过校验。')
    elif out_of_range:
        L.append('⚠️ 以下引用指向不存在的需求条目：')
        L.append('')
        L.append('| 任务 | 引用 | 问题 |')
        L.append('| --- | --- | --- |')
        for tid, ref, why in out_of_range:
            L.append(f'| {tid} | {ref} | {why} |')
    else:
        L.append('`tasks.md` 中的全部需求引用均落在有效范围内，无越界。')
        L.append('')
        L.append('各需求验收标准条数：')
        L.append('')
        L.append('| 需求 | ' + ' | '.join(str(n) for n, _, _ in reqs) + ' |')
        L.append('| --- | ' + ' | '.join('---' for _ in reqs) + ' |')
        L.append('| 条数 | ' + ' | '.join(str(c) for _, _, c in reqs) + ' |')
    L.append('')

    return '\n'.join(L) + '\n', {
        'spec': spec,
        'reqs': len(reqs),
        'tasks': len(tasks),
        'must': len(must),
        'must_done': len(must_done),
        'opt': len(opt),
        'opt_done': len(opt_done),
        'no_refs': bool(reqs) and not any(cover.values()) and not is_as_built,
        'gaps': ([n for n, _, _ in reqs if not cover[n]]
                 if reqs and not is_as_built else []),
        'out_of_range': out_of_range,
        'is_bugfix': not reqs and bool(bug_text),
        'is_as_built': is_as_built,
    }


def main():
    specs = sorted(
        s for s in os.listdir(SPECS_DIR)
        if os.path.isdir(os.path.join(SPECS_DIR, s)) and not s.startswith('_')
    )
    summary = []
    for s in specs:
        content, meta = build(s)
        out = os.path.join(SPECS_DIR, s, 'traceability.md')
        write_atomic(out, content)
        summary.append(meta)
        print(f'生成 {s}/traceability.md')

    print('\n' + '=' * 78)
    print(f'{"spec":<32}{"需求":>4}{"任务":>5}{"必做":>8}{"可选":>8}  问题')
    print('=' * 78)
    for m in summary:
        issues = []
        if m['is_bugfix']:
            issues.append('bugfix 型')
        if m['is_as_built']:
            issues.append('as-built 型（无任务计划）')
        if m['no_refs']:
            issues.append('无 _Requirements 标注')
        if m['gaps']:
            issues.append(f'需求无任务覆盖:{m["gaps"]}')
        if m['out_of_range']:
            issues.append(f'越界引用 {len(m["out_of_range"])} 处')
        print(f'{m["spec"]:<32}{m["reqs"]:>4}{m["tasks"]:>5}'
              f'{m["must_done"]:>4}/{m["must"]:<3}{m["opt_done"]:>4}/{m["opt"]:<3}  '
              f'{"; ".join(issues) if issues else "-"}')
    print('=' * 78)
    tm = sum(m['must'] for m in summary)
    tmd = sum(m['must_done'] for m in summary)
    to = sum(m['opt'] for m in summary)
    tod = sum(m['opt_done'] for m in summary)
    print(f'合计（全部 {len(summary)} 个 spec）：必做 {tmd}/{tm}，可选 {tod}/{to}')


if __name__ == '__main__':
    main()

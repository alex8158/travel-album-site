#!/usr/bin/env python3
"""
核对「已勾选完成」的任务是否真的落地。

做法：从每个已完成任务（- [x]）的描述及其子行中抽取代码文件路径，
检查这些文件是否真实存在。文件不存在 = 任务声称完成但产物缺失。

这是机械核对，只能验证「文件存在」，不能验证「行为正确」。
用法: python3 .kiro/specs/_check_completed.py
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPECS = os.path.join(ROOT, '.kiro', 'specs')

# 同 _gen_traceability：确保能取到同目录的 _spec_parse。
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import _spec_parse  # noqa: E402

TASK_LINE = _spec_parse.TASK_LINE  # canonical 定义见 _spec_parse.py

# 反引号内、看起来像项目内代码文件的路径
PATH_RE = re.compile(r'`([a-zA-Z0-9_\-./]+\.(?:ts|tsx|py|json|md|sh))`')

# 这些前缀才认为是项目内路径
VALID_PREFIX = ('server/', 'client/', 'deploy/', 'docs/', '.kiro/')

# --------------------------------------------------------------------------
# 状态标注（authority: docs/agent/change-boundaries.md 状态标记约定）
#
#   `- [ ]` + 【待验证】 代码已存在但未经验收标准逐条核对  → 不勾
#   `- [ ]` + 【先保留】 用户明确决定既不推进也不关闭      → 不勾
#
# 两者都要求任务保持未勾选，因此「文件已存在」对它们不是漏勾选的证据，而是标注
# 成立的前提。只用于抑制下方的反向提示，不参与正向检查、不改变勾选状态与计数。
#
# 识别位置严格受限：
#   【待验证】只认 canonical TASK_LINE 解析出的 title 内的完整 token；
#   【先保留】只认任务正文里的 blockquote 行，且不跨过下一个正式任务。
# 普通正文、小节标题、Notes、banner 中的同字面文本一律不算。
# --------------------------------------------------------------------------
PENDING_TOKEN = '【待验证】'
DEFERRED_TOKEN = '【先保留】'
DEFERRED_BLOCKQUOTE = re.compile(r'^\s*>')


def collect():
    results = []
    for spec in sorted(os.listdir(SPECS)):
        d = os.path.join(SPECS, spec)
        if not os.path.isdir(d) or spec.startswith('_'):
            continue
        tp = os.path.join(d, 'tasks.md')
        if not os.path.exists(tp):
            continue
        lines = io.open(tp, encoding='utf-8').read().split('\n')
        cur = None
        for line in lines:
            m = TASK_LINE.match(line)
            if m:
                _, mark, star, tid, title = m.groups()
                cur = {'spec': spec, 'id': tid, 'done': mark == 'x',
                       'optional': star == '*', 'text': title,
                       'pending': PENDING_TOKEN in title,
                       'deferred_own': False}
                results.append(cur)
                continue
            if cur is None:
                continue
            # blockquote 标注单独判定：它的缩进在各 spec 中不统一（2 或 4 空格），
            # 因此不能依赖下方的正文缩进条件。归属于「上一个正式任务」，遇到下一个
            # TASK_LINE 即结束（由 cur 的重新赋值保证）。
            if DEFERRED_BLOCKQUOTE.match(line) and DEFERRED_TOKEN in line:
                cur['deferred_own'] = True
            if line.startswith(('    ', '\t', '  -')):
                cur['text'] += ' ' + line.strip()
    return results


def suppresses_missed_checkbox_hint(task, by_key):
    """该任务是否豁免「未勾选但文件已存在」反向提示。

    自身标题带【待验证】，或自身/任一正式祖先任务带【先保留】标注即豁免。
    继承只沿正式 task id 层级（12 → 12.1 → 12.1.1），不沿 markdown 缩进，也不
    沿任务间依赖关系传播。
    """
    if task['pending'] or task['deferred_own']:
        return True
    parts = task['id'].split('.')
    for i in range(1, len(parts)):
        ancestor = by_key.get((task['spec'], '.'.join(parts[:i])))
        if ancestor is not None and ancestor['deferred_own']:
            return True
    return False


def main():
    tasks = collect()
    done = [t for t in tasks if t['done']]

    missing = []
    checked_files = set()
    for t in done:
        for p in PATH_RE.findall(t['text']):
            if not p.startswith(VALID_PREFIX):
                continue
            checked_files.add(p)
            if not os.path.exists(os.path.join(ROOT, p)):
                missing.append((t['spec'], t['id'], p))

    print('已勾选完成的任务数: %d' % len(done))
    print('从其中抽取到的项目内文件路径数: %d' % len(checked_files))
    print('')
    if missing:
        print('!! 声称完成但文件不存在 (%d 处):' % len(missing))
        for spec, tid, p in missing:
            print('   %-30s 任务 %-8s -> %s' % (spec, tid, p))
    else:
        print('OK: 所有已完成任务提到的文件均存在')

    # 反向检查：未完成任务提到的文件却已存在（可能是漏勾选）。
    # 带【待验证】/【先保留】标注的任务按 authority 必须保持未勾选，文件存在是标注
    # 成立的前提而非漏勾选证据，故跳过；正向检查不受影响。
    by_key = {(t['spec'], t['id']): t for t in tasks}
    undone = [t for t in tasks if not t['done']]
    suspicious = []
    for t in undone:
        if suppresses_missed_checkbox_hint(t, by_key):
            continue
        for p in PATH_RE.findall(t['text']):
            if not p.startswith(VALID_PREFIX):
                continue
            if os.path.exists(os.path.join(ROOT, p)):
                suspicious.append((t['spec'], t['id'], t['optional'], p))
    print('')
    if suspicious:
        print('提示: 未勾选任务提到的文件已存在 (%d 处，可能是漏勾选或文件被其他任务创建):' % len(suspicious))
        for spec, tid, opt, p in suspicious:
            print('   %-30s 任务 %-8s%s -> %s' % (spec, tid, '*' if opt else ' ', p))


if __name__ == '__main__':
    main()

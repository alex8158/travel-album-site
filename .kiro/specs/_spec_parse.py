"""spec 文档的共享解析定义。

存在的唯一理由：`tasks.md` 的任务行语法此前在 `_gen_traceability.py` 与
`_check_completed.py` 中各有一份等价 regex。两份定义当时行为一致，但没有单一
来源，任何一侧演进都会静默产生分歧。本模块把该语法收敛为唯一 authority。

范围刻意限制为「任务行语法」这一件事。需求引用语法（`_Requirements:` /
`**Validates:**`）只有 generator 使用，不在此处共享；checker 不解析需求引用。
不要把本模块扩展成通用 parser 框架。

用法：
    from _spec_parse import TASK_LINE, match_task_line
"""
import re

# tasks.md 的任务行。分组：
#   1 缩进  2 勾选标记（' ' 或 'x'）  3 可选标记（'' 或 '*'）  4 任务编号  5 标题
#
# 编号形如 `1`、`1.2`、`5.3b`。标题捕获为非贪婪并剥掉尾随空白，因此
# `- [x] 1.1 标题   ` 与 `- [x] 1.1 标题` 得到相同结果。
TASK_LINE = re.compile(
    r'^(\s*)-\s+\[([ x])\](\*?)\s+([0-9]+(?:\.[0-9]+[a-z]?)?)\.?\s+(.*?)\s*$'
)


def match_task_line(line):
    """匹配一行 tasks.md。命中返回 dict，否则返回 None。

    返回字段：
        indent    缩进空格数
        done      是否已勾选
        optional  是否为 `- [ ]*` 可选任务
        id        任务编号字符串
        title     标题（已剥离首尾空白）
    """
    m = TASK_LINE.match(line)
    if not m:
        return None
    indent, mark, star, tid, title = m.groups()
    return {
        'indent': len(indent),
        'done': mark == 'x',
        'optional': star == '*',
        'id': tid,
        'title': title.strip(),
    }

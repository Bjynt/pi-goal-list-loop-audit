# goal

Codex 风格的 `/goal` 命令 — 持久目标驱动自主循环，支持任务追踪、证据验证、Token/时间预算、阻塞检测。

## 功能

- **自主循环**：`/goal <目标>` 启动后，AI 自动拆分任务并持续执行
- **证据验证**：完成任务必须提供具体证据，不能空口完成
- **预算控制**：Token 和时间双预算，70% 预警、90% 收尾、100% 终止
- **阻塞检测**：连续无进展自动阻塞，用户可手动 resume
- **持久化**：状态通过 session entries 保存，重启后自动恢复

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/<branch>/extensions/goal \
      ~/.pi/agent/extensions/goal

# npm 方式（正式）
pi install npm:@zhushanwen/pi-goal
```

## 使用

```
/goal 修复项目中所有失败的测试
/goal 实现用户认证功能 --tokens 500000 --timeout 30
/goal status      # 查看进度
/goal resume      # 恢复（blocked → active）
/goal clear       # 清除
```

## 文件结构

```
goal/
├── index.ts            # 入口 — 命令、事件、工具注册 + __goalInit
└── src/
    ├── index.ts        # 工厂入口（注册 tool/command/events，全部委托 adapters）
    ├── commands.ts     # /goal 命令参数解析
    ├── constants.ts    # 语义常量
    ├── ports.ts        # Pi 能力抽象（Persistence/Ui/Messaging/Session）
    ├── service.ts      # 协调层 — applyToolAction / applyEvent 双入口
    ├── persistence.ts  # serialize/deserialize + GoalHistoryEntry
    ├── session.ts      # 运行时句柄 + 状态重建 + entry GC
    ├── engine/         # 零 Pi 依赖的纯状态机（goal/task/budget/types）
    ├── adapters/       # Pi 桥接（tool/command/event-adapter + actions）
    └── projection/     # 渲染（widget/prompts/result）
```

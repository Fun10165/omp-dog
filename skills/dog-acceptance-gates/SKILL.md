---
name: dog-acceptance-gates
description: 用 DoG(DAG of Goals)对非形式化交付物做机械验收:拆成子目标 → 每项一个独立判据 → 落盘证据台账。当用户要求「给这份东西做验收 / 加质量门禁 / 逐项检查是否真的达标」,或交付物是语义性目标(讲得好不好、有没有 AI 味、风格统不统一)无法用一条命令判定时使用。
---

# DoG 验收门禁(OMP)

把「这份东西做好了没」变成「逐项验收,每项都有独立裁判」:每个子目标配一个判据内核,
引擎执行判据并落盘证据,总目标由子目标的组合表达式算出结果。

## 什么时候用 / 什么时候不用

用:交付物是**语义性目标**,拆成若干可分别评看的子目标;需要**可复跑、可继承**的验收(改完再跑,没变的项 0 成本复用上次判决)。

不用:能用一条命令精确判定的东西(那是普通 CI/测试脚本)。**任何分支都不能全是程序化节点**——
DoG 是判断层,不是规则层的替代品。

边界:**DoG 不执行生成/开发动作**,只判"东西好不好"。产物由你(或你派发的 executor)做出来。

## 工具面

顶层工具:`dog_create`、`dog_run`、`dog_status`。
按需(设备式,用 `read xd://dog_validate` 等调用):`dog_validate`、`dog_cancel`、`dog_graph`、`dog_ledger`。

状态落盘在 **`<项目>/.omp/dog/`**(图、run、捕获、证据台账都在项目里,随仓库走)。

## 图(schemaVersion `0.9`)

顶层 6 个必填字段:`schemaVersion` / `id` / `root` / `nodes` / `contains` / `dependsOn`。

**节点两种**:

- `leaf`:`{kind, title, constraint: "hard"|"soft", target, verifier}` — `target` 是**工作区相对路径**
  (文件,或目录→引擎打包成 tar),`verifier` 必填。
- `composite`:`{kind, title, constraint, target, completion, verifier?}` — `completion` 组合子目标;
  可选的 `verifier` 是**整体断言**(子树全结算后再判一次,**只降不升**)。

**边**:

- `contains`:`{parent, child, required: true|false, failure: "fatal"|"tolerable"|"degrade", degradeTo?}`
  — `fatal` 会把失败传给上级,`tolerable` 只算部分问题,`degrade` 失败时改判 `degradeTo`。
- `dependsOn`:`{source, target}` 读作「**source 等 target 先完成**」。方向常写反:
  想让 A 先跑再跑 B,写 `{source: "B", target: "A"}`。

**completion 表达式**:`{op:"ref",id}` / `{op:"all",items}` / `{op:"any",items}` / `{op:"atLeast",count,items}` / `{op:"not",item}`。

**判据只有两种**:

- `{"mode":"programmatic","script":"file-non-empty"}` — 宿主脚本库(`<扩展>/scripts/`),引擎把
  **捕获副本路径**作为唯一参数传给脚本,脚本往 stdout 写 `{"verdict":"pass|fail|inconclusive","evidence":<任意 JSON>}`。
  非零退出或输出不可解析 = `inconclusive`。
- `{"mode":"agentic","instruction":"……"}` — instruction 就是判据。引擎把它连同**冻结的捕获副本**交给一个
  只读的 `dog-verifier` 子代理,子代理写结算文件。

`root` 必须是 `composite` 且 `constraint: "hard"`。

## 标准流程

```
① dog_create {graph}          → 校验 + 固化对象(每个 target 捕获成不可变字节)
② dog_run {graphId}           → 三种返回之一:
     · status:"needs_verification" → 逐个派发 pending 里的 verifierTask(见下),然后回到 ②
     · run 摘要(rootState 终态) → 结束
     · 报错 → 修图重来
③ dog_status / dog_ledger     → 读每个节点的状态、证据、运行时事件
```

**②的派发**:`pending[i].verifierTask` 是给子代理的完整交办文本,**原样**发给 `task`:

```json
{"context":"DoG agentic verification","tasks":[{"name":"dog-1","agent":"dog-verifier","task":"<verifierTask 原文>"}]}
```

派发完再调一次 `dog_run`;引擎读到结算文件才会判该项。**绝不要自己声称某项已验证**——
引擎只认结算文件,你自己写的那份不算(且有 mtime/摘要绑定校验)。

产物改了之后要**重新 `dog_create`**(重新捕获);否则引擎判的还是旧字节,
新内容会被判成 stale 并要求重新验证。

## 结果语义

| 看到 | 含义 | 你该做什么 |
|---|---|---|
| `rootState: "success"` | 各硬项全过 | 汇报通过 + 关键 evidence |
| `rootState: "failure"` | 有 fatal 项失败 | 找出 `failure` 节点,把 evidence/reason 里的具体罪名转达用户 |
| `rootState: "needs_replan"` | 有节点判不了 | **不要猜**;如实转达"无法自动判定 + 原因" |
| goal `inherited` | 对象与判据都没变,复用上次判决 | 正常,`inheritedFrom` 指向来源 run |
| goal `needs_human` | 判据执行器诚实说判不了 | 转达理由;要更精确就改 instruction 后重新 create |
| goal `blocked` | 依赖项未完成 | 看 `dependsOn` |

`inconclusive` 是**设计内的诚实**,不是失败,更不是通过。

## 面板

- 状态行常驻:`dog <rootState> ✓↺…`(每个节点一个字形)。
- 运行中/需要派发时,编辑器上方出现面板(图名、统计、逐节点行)。
- `/dog [graphId]` 打开面板并在对话里打一张 run 报告卡(逐节点状态 + 证据)。

## 报告格式(收口用)

```
图: <id> @ <digest 前 12>
run: <runId>  终态: <rootState>
节点: <goalId> | <state> | 证据摘要 / 失败原因
根结果: 通过/不通过 + 一句话原因
```

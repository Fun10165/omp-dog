# DoG 演示模块

四张可直接运行的演示图,对象是工作区里的文件(把 `target` 改成你的相对路径即可)。

## 1. `article-quality.graph.json` — 非形式化目标的四维拆解

把「这是一篇真正有质量的好文章」(非形式化、无唯一判准)拆成四个可独立评看的子目标 + 一个根整体断言:

- `no-slop` — AI 味儿(模板腔/空口号/模糊词)
- `dense-fun` — 信息密度与趣味(每段有思想+证据)
- `readable` — 易懂、符合认知规律(定义先行/段间有桥)
- `human-qual` — 人类质感(句式节奏/有立场)
- `root` — 单维都过后,作为一篇**完整文章**是否成立(整体断言,只降不升)
- `phrase-hint` — 程序化辅助(模板词表脚本,soft/tolerable)

**要演示**:四维全部由 agentic 验证会话判定;程序化只做辅助;根节点整体断言只会降级。

## 2. `dog-smoke-multi.graph.json` — 多级 + 混合判定(功能全景)

- **3 层结构**:`root` → `content-group` → 四个 agentic 叶;两个 composite 各带整体断言
- **程序化叶**:`phrase-hint`(slop-phrases)、`file-nonempty`(file-non-empty)
- **依赖边**:`content-group` 依赖 `file-nonempty`(`source` depends on `target`)
- **失败传播**:任一 hard 子项失败 → 该组失败 → 根失败;`tolerable` 项不影响根

## 3. `do-dog-genesis.graph.json` — 大图演示(24 个节点)

以「生成 DoG 图自身」为验收对象的示例,用来看多节点图在报告里的形状。

## 4. `team-sync-report.graph.json` — 汇报质量门禁

面向「给团队写的同步报告」的全 agentic 例子。

## 怎么跑

```bash
cd <项目目录>
<repo>/cli.ts create <repo>/examples/article-quality.graph.json --project .
<repo>/cli.ts run article-quality --project .            # 退出码 0 = success/partial_success
<repo>/cli.ts status article-quality --project .         # 逐目标状态与证据
```

在 `host` 会话里同样四件事是四个工具:`dog_validate` / `dog_create` / `dog_run` / `dog_status`。

## 预期行为(可当验收清单)

- **agentic 叶**:引擎为自己的每个目标起一个 `omp --mode rpc` 验证会话(只读工具面),判决经
  `dog_submit_verdict` 回到引擎;报告里带 `verifier.sessionFile`(转写路径)。
- **程序化叶**:立即执行、不排队;输出同样是 `{"verdict","evidence"}`。
- **复跑同图(对象+判据不变)**:已结算目标标记 `inherited`(复用,不再判定)。
- **子树失败**:composite **跳过**自己的整体断言,原因定位到具体子项。
- **判不了**:`needs_human`(根为 `needs_replan`)——这是设计内的诚实,不是失败。
- **超时或没交判决**:同样落 `inconclusive → needs_human`,绝不通过。

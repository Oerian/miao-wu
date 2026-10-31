# 绘图知识库（示例骨架）

> 复制为 `config/draw-knowledge.md` 后按你的模型/LoRA 习惯填内容。
> 这份文件每轮绘图都会整份进 system prompt，写你最常用的出图经验即可。
> 没有这个文件也能跑，只是模型对出图格式全靠猜。

## 出图 tag 结构

- 画质词在前：`masterpiece, best quality, ...`
- 主体一句话，身体特征、服装、动作、背景依次排
- negative 固定一套低质量词

## 常用 LoRA（按你的模型填）

| LoRA | 基座 | 触发词 | 用法 |
|---|---|---|---|
| （示例）某角色 | Illustrious | `角色名, 特征词` | `<lora:xxx:0.8>` |

## 常见坑

- 单 tag 过长会稀释权重，重要的放前面
- 性别锚定：`1girl` / `1boy` 必写，不然容易崩
- 手部崩坏加 negative：`bad hands, extra fingers`

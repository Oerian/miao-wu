/**
 * 本地预览帮助图：不走云崽，直接 art-template + puppeteer 截图
 *
 * 用法：node plugins/miao-wu/test/render-help.mjs [输出路径]
 * 产物默认 data/help-preview.png
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import template from "art-template"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../../..") // Miao-Yunzai 根目录
const { buildHelpData } = await import("../lib/helpcard.js")
const { loadConfig } = await import("../lib/config.js")
const { loadCharacter, listCharacters } = await import("../lib/character.js")

const conf = loadConfig()
const card = loadCharacter(conf, "yinghua") || listCharacters(conf)[0]
const data = buildHelpData({ conf, card, cards: listCharacters(conf).length, profile: "default", stOn: true })

const html = fs.readFileSync(data.tplFile, "utf8")
const out = template.render(html, { ...data, resPath: "./resources/" })

const tmpDir = path.join(ROOT, "temp", "html", "miao-wu")
fs.mkdirSync(tmpDir, { recursive: true })
const tmpFile = path.join(tmpDir, "help-preview.html")
fs.writeFileSync(tmpFile, out, "utf8")

const target = process.argv[2] || path.join(HERE, "..", "data", "help-preview.png")
fs.mkdirSync(path.dirname(target), { recursive: true })

const pups = await import("puppeteer")
const puppeteer = pups.default
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
})
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
await page.goto(`file:///${tmpFile.replace(/\\/g, "/")}`, { waitUntil: "networkidle0" })
const el = (await page.$("#container")) || (await page.$("body"))
const box = await el.boundingBox()
await el.screenshot({ path: target, type: "png" })
await browser.close()

console.log(`已生成 ${target}`)
console.log(`尺寸 ${Math.round(box.width)} × ${Math.round(box.height)}`)

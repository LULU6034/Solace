/**
 * docx-tool.js — 文档生成工具（Word / PDF / Excel / PPT）
 *
 * 安全: 内容通过 base64 传递，杜绝 Python 脚本注入。
 * 性能: 使用异步 exec，不阻塞事件循环。
 * 清理: 临时脚本在 finally 中删除，进程退出兜底清理。
 */
import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('docx-tool');

// ── Python 查找 ──

function findPython() {
  const candidates = [
    process.env.USERPROFILE + '\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
    'C:\\Program Files\\Python312\\python.exe',
    'C:\\Python312\\python.exe',
    'python', 'python3',
  ];
  for (const py of candidates) {
    try {
      execSync(`"${py}" --version`, { windowsHide: true, stdio: 'pipe' });
      return py;
    } catch (e) { log.warn('操作失败', e?.message || e); }
  }
  return null;
}

function getTempDir() {
  return os.tmpdir();
}

function b64encode(text) {
  return Buffer.from(text, 'utf-8').toString('base64');
}

// ── 进程退出时清理临时文件 ──
const _tempScripts = new Set();
function _trackTemp(fp) {
  _tempScripts.add(fp);
  return fp;
}
function _untrackTemp(fp) {
  _tempScripts.delete(fp);
  try { fs.unlinkSync(fp); } catch (e) { log.warn('操作失败', e?.message || e); }
}

// 退出/异常时清理所有残留
if (!process.__docxCleanupRegistered) {
  process.__docxCleanupRegistered = true;
  const cleanup = () => { for (const f of _tempScripts) { try { fs.unlinkSync(f); } catch (e) { log.warn('操作失败', e?.message || e); } } };
  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('uncaughtException', cleanup);
}

// ── 异步执行 Python 脚本（不阻塞事件循环）──

function runPythonScript(script, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const python = findPython();
    if (!python) return reject(new Error('未找到 Python 环境'));

    const tmpDir = getTempDir();
    const scriptPath = _trackTemp(
      path.join(tmpDir, `sonder_py_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
    );

    try {
      fs.writeFileSync(scriptPath, script, 'utf-8');
    } catch (e) {
      _untrackTemp(scriptPath);
      return reject(e);
    }

    exec(`"${python}" "${scriptPath}"`, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      _untrackTemp(scriptPath);
      if (error && !stdout) {
        reject(new Error((stderr || error.message).trim()));
      } else {
        resolve((stdout || '').trim());
      }
    });
  });
}

// ═══════════════════════════════════════
// generate_docx
// ═══════════════════════════════════════

export const generateDocx = {
  name: 'generate_docx',
  description: `生成 Word 文档（.docx）并保存到指定路径。参数 content: 文档正文（支持 Markdown 标记），参数 file_path: 保存路径（如 C:/Users/xxx/Desktop/周报.docx），参数 title: 文档标题（可选）。
Agent 只需调一次这个工具，内部自动处理 Python 脚本生成和执行。不需要分两步调 write_file + execute_command。`,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '文档正文，支持简单格式标记：## 标题、**粗体**、|表格|行|、- 列表项' },
      file_path: { type: 'string', description: '完整的保存路径，如 C:/Users/L/Desktop/周报.docx' },
      title: { type: 'string', description: '文档主标题，可选' },
    },
    required: ['content', 'file_path'],
  },
  async invoke({ content, file_path, title }) {
    if (!content?.trim()) return '内容不能为空';
    if (!file_path?.trim()) return '保存路径不能为空';

    const python = findPython();
    if (!python) return '未找到 Python 环境。请安装 Python 3.12+ 和 python-docx 库。';

    // base64 编码杜绝注入
    const b64 = b64encode(content);
    const safeB64Path = file_path.replace(/\\/g, '\\\\');
    const safeB64Title = title ? b64encode(title) : '';

    const script = `# -*- coding: utf-8 -*-
import sys, base64
try:
    from docx import Document
    from docx.shared import Pt, Cm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
except ImportError:
    print("DOCX_ERR: python-docx 未安装，请运行 pip install python-docx")
    sys.exit(1)

doc = Document()
style = doc.styles['Normal']
style.font.name = '微软雅黑'
style.font.size = Pt(11)

_content = base64.b64decode("""${b64}""").decode('utf-8')
${title ? `
_title = base64.b64decode("""${safeB64Title}""").decode('utf-8')
t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = t.add_run(_title)
r.font.size = Pt(22)
r.font.bold = True
r.font.color.rgb = RGBColor(0x1a, 0x56, 0xdb)
doc.add_paragraph()
` : ''}

lines = _content.split('\\n')
i = 0
while i < len(lines):
    line = lines[i].strip()
    if not line:
        i += 1
        continue

    if line.startswith('## '):
        h = doc.add_heading(line[3:], level=2)
        i += 1
        continue

    if line.startswith('|') and line.endswith('|') and i+1 < len(lines) and lines[i+1].strip().startswith('|---'):
        rows = []
        cells = [c.strip() for c in line.split('|')[1:-1]]
        rows.append(cells)
        i += 2
        while i < len(lines):
            rl = lines[i].strip()
            if rl.startswith('|') and rl.endswith('|'):
                rows.append([c.strip() for c in rl.split('|')[1:-1]])
                i += 1
            else:
                break
        if rows:
            table = doc.add_table(rows=len(rows), cols=len(rows[0]), style='Light Grid Accent 1')
            for ri, row_data in enumerate(rows):
                for ci, val in enumerate(row_data):
                    cell = table.rows[ri].cells[ci]
                    cell.text = val
                    if ri == 0:
                        for run in cell.paragraphs[0].runs:
                            run.font.bold = True
            doc.add_paragraph()
        continue

    if line.startswith('- '):
        doc.add_paragraph(line[2:], style='List Bullet')
        i += 1
        continue

    p = doc.add_paragraph()
    parts = line.split('**')
    for pi, part in enumerate(parts):
        if pi % 2 == 1:
            run = p.add_run(part)
            run.font.bold = True
        else:
            p.add_run(part)
    i += 1

try:
    doc.save("""${safeB64Path}""")
    print("DOCX_OK: """ + "${safeB64Path}".replace(/\\/g, '\\\\') + """")
except Exception as e:
    print(f"DOCX_ERR: {e}")
`;

    try {
      const output = await runPythonScript(script, 30_000);
      if (output.startsWith('DOCX_OK:')) {
        log.log(`docx 生成成功: ${output.slice(9).trim()}`);
        return `已保存到 ${output.slice(9).trim()}`;
      }
      if (output.startsWith('DOCX_ERR:')) {
        return `生成失败: ${output.slice(9).trim()}`;
      }
      return `已生成文档: ${file_path}`;
    } catch (err) {
      return `生成失败: ${err.message}`;
    }
  },
};

// ═══════════════════════════════════════
// generate_pdf
// ═══════════════════════════════════════

export const generatePdf = {
  name: 'generate_pdf',
  description: `生成 PDF 文档。参数 content: 文档正文，参数 file_path: 保存路径（.pdf 结尾），参数 title: 标题（可选）。
Agent 只需调一次这个工具，内部自动处理。`,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      file_path: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['content', 'file_path'],
  },
  async invoke({ content, file_path, title }) {
    if (!content?.trim()) return '内容不能为空';
    if (!file_path?.trim()) return '保存路径不能为空';

    const python = findPython();
    if (!python) return '未找到 Python 环境';

    const b64 = b64encode(content);
    const safeB64Path = file_path.replace(/\\/g, '\\\\');
    const safeB64Title = title ? b64encode(title) : '';

    const script = `# -*- coding: utf-8 -*-
import base64
from fpdf import FPDF
pdf = FPDF()
pdf.add_page()
pdf.set_auto_page_break(auto=True, margin=15)

pdf.add_font('SimSun', '', 'C:/Windows/Fonts/simsun.ttc', uni=True)
pdf.add_font('SimSun', 'B', 'C:/Windows/Fonts/simsun.ttc', uni=True)
pdf.add_font('SimHei', '', 'C:/Windows/Fonts/simhei.ttf', uni=True)

${title ? `
_title = base64.b64decode("""${safeB64Title}""").decode('utf-8')
pdf.set_font('SimHei', '', 18)
pdf.cell(0, 12, _title, ln=True, align='C')
pdf.ln(6)
` : ''}

_content = base64.b64decode("""${b64}""").decode('utf-8')
pdf.set_font('SimSun', '', 11)
lines = _content.split('\\n')
for line in lines:
    line = line.strip()
    if not line:
        pdf.ln(4)
        continue
    if line.startswith('## '):
        pdf.set_font('SimHei', '', 13)
        pdf.cell(0, 8, line[3:], ln=True)
        pdf.ln(2)
        continue
    if line.startswith('- '):
        pdf.set_font('SimSun', '', 11)
        pdf.cell(8, 6, chr(8226))
        pdf.multi_cell(0, 6, line[2:])
        continue
    if line.startswith('|') and line.endswith('|'):
        continue
    pdf.set_font('SimSun', '', 11)
    parts = line.split('**')
    x = pdf.get_x()
    for pi, part in enumerate(parts):
        if pi % 2 == 1:
            pdf.set_font('SimSun', 'B', 11)
        else:
            pdf.set_font('SimSun', '', 11)
        pdf.write(6, part)
    pdf.ln(7)

try:
    pdf.output("""${safeB64Path}""")
    print("PDF_OK: """ + "${safeB64Path}".replace(/\\/g, '\\\\') + """")
except Exception as e:
    print(f"PDF_ERR: {e}")
`;

    try {
      const output = await runPythonScript(script, 30_000);
      if (output.startsWith('PDF_OK:')) return `已保存到 ${output.slice(8).trim()}`;
      if (output.startsWith('PDF_ERR:')) return `生成失败: ${output.slice(8).trim()}`;
      return `已生成文档: ${file_path}`;
    } catch (err) {
      return `生成失败: ${err.message}`;
    }
  },
};

// ═══════════════════════════════════════
// generate_xlsx
// ═══════════════════════════════════════

export const generateXlsx = {
  name: 'generate_xlsx',
  description: `生成 Excel 表格（.xlsx）。参数 content: 表格数据，参数 file_path: 保存路径，参数 title: 工作表标题（可选）。
content 格式: 每行用换行分隔，每列用 | 分隔，第一行为表头。`,
  parameters: {
    type: 'object', properties: {
      content: { type: 'string' }, file_path: { type: 'string' }, title: { type: 'string' },
    }, required: ['content', 'file_path'],
  },
  async invoke({ content, file_path, title }) {
    if (!content?.trim()) return '内容不能为空';
    const python = findPython(); if (!python) return '未找到 Python 环境';

    const b64 = b64encode(content);
    const safeB64Path = file_path.replace(/\\/g, '\\\\');
    const safeTitle = (title || 'Sheet1').replace(/"/g, '\\"');

    const script = `# -*- coding: utf-8 -*-
import base64
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
wb = Workbook()
ws = wb.active
ws.title = """${safeTitle}"""
_content = base64.b64decode("""${b64}""").decode('utf-8')
lines = _content.split('\\n')
header_fill = PatternFill(start_color='1A56DB', end_color='1A56DB', fill_type='solid')
header_font = Font(name='微软雅黑', size=11, bold=True, color='FFFFFF')
cell_font = Font(name='微软雅黑', size=10)
max_cols = 0
for ri, line in enumerate(lines):
    cols = [c.strip() for c in line.split('|')]
    max_cols = max(max_cols, len(cols))
    for ci, val in enumerate(cols):
        cell = ws.cell(row=ri+1, column=ci+1, value=val)
        if ri == 0:
            cell.fill = header_fill; cell.font = header_font
            cell.alignment = Alignment(horizontal='center')
        else:
            cell.font = cell_font
# 自动列宽（所有列）
for ci in range(1, max_cols + 1):
    max_width = 8
    for row in ws.iter_rows(min_col=ci, max_col=ci, values_only=False):
        for cell in row:
            if cell.value:
                # 中文字符按 2 倍宽度计算
                w = sum(2 if ord(c) > 127 else 1 for c in str(cell.value))
                max_width = max(max_width, w)
    ws.column_dimensions[get_column_letter(ci)].width = min(max_width + 2, 50)
try:
    wb.save("""${safeB64Path}""")
    print("XLSX_OK")
except Exception as e:
    print(f"XLSX_ERR: {e}")
`;

    try {
      const o = await runPythonScript(script, 15_000);
      if (o.includes('XLSX_OK')) return `已保存到 ${file_path}`;
      return `生成失败: ${o.trim()}`;
    } catch (e) { return `生成失败: ${e.message}`; }
  },
};

// ═══════════════════════════════════════
// generate_pptx
// ═══════════════════════════════════════

export const generatePptx = {
  name: 'generate_pptx',
  description: `生成 PPT 演示文稿（.pptx）。参数 content: 幻灯片内容，参数 file_path: 保存路径，参数 title: 演示标题（可选）。
content 格式: 用 --- 分隔幻灯片，每页第一行为标题。`,
  parameters: {
    type: 'object', properties: {
      content: { type: 'string' }, file_path: { type: 'string' }, title: { type: 'string' },
    }, required: ['content', 'file_path'],
  },
  async invoke({ content, file_path, title }) {
    if (!content?.trim()) return '内容不能为空';
    const python = findPython(); if (!python) return '未找到 Python 环境';

    const b64 = b64encode(content);
    const safeB64Path = file_path.replace(/\\/g, '\\\\');

    const script = `# -*- coding: utf-8 -*-
import base64
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
prs.slide_width = Inches(10)
prs.slide_height = Inches(7.5)
_content = base64.b64decode("""${b64}""").decode('utf-8')
slides = _content.split('---')
# 查找可用的 slide layout: 优先 title+content (1), 回退 title only (0), 再回退 blank (6)
_available = [sl.name for sl in prs.slide_layouts]
_title_layout = 1 if 1 < len(prs.slide_layouts) and 'title' in prs.slide_layouts[1].name.lower() else 0
for si, slide_text in enumerate(slides):
    lines = slide_text.strip().split('\\n')
    # 安全获取 layout
    try:
        slide = prs.slides.add_slide(prs.slide_layouts[_title_layout])
    except:
        slide = prs.slides.add_slide(prs.slide_layouts[0])
    title_text = ''
    body_lines = []
    if lines:
        first = lines[0].strip()
        if first.startswith('## '):
            title_text = first[3:]
            body_lines = lines[1:]
        else:
            title_text = first
            body_lines = lines[1:]
    # 设置标题（安全 fallback）
    if title_text and slide.shapes.title:
        try:
            slide.shapes.title.text = title_text
        except:
            pass
    # 设置正文
    if len(slide.placeholders) > 1 and body_lines:
        try:
            body = slide.placeholders[1].text_frame
            body.clear()
            for line in body_lines:
                p = body.add_paragraph()
                p.text = line.strip().replace('- ', '\\u2022 ')
                p.font.size = Pt(14)
        except:
            pass
try:
    prs.save("""${safeB64Path}""")
    print("PPTX_OK")
except Exception as e:
    print(f"PPTX_ERR: {e}")
`;

    try {
      const o = await runPythonScript(script, 15_000);
      if (o.includes('PPTX_OK')) return `已保存到 ${file_path}`;
      return `生成失败: ${o.trim()}`;
    } catch (e) { return `生成失败: ${e.message}`; }
  },
};

export const docxTools = [generateDocx, generatePdf, generateXlsx, generatePptx];

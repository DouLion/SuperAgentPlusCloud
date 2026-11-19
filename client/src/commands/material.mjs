// sap material：材料导入、AI 提取与人工采纳/拒绝（C 枝）。
// 提取只产生 draft；采纳才生成正式需求或约定草稿。

import fs from 'node:fs';
import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'material',
  usage: 'sap material add|list|show|extract|accept|reject ...',
};

const KIND_TEXT = {
  requirement: '需求',
  convention: '约定',
  decision: '决定',
};

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function printMaterial(out, material) {
  out(`${material.material_id}  ${material.kind}  ${material.title}  ${material.created_at}`);
  if (material.source_ref) out(`  来源：${material.source_ref}`);
  if (material.extractions) {
    const counts = material.extractions.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const text = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ') || '无';
    out(`  提取：${material.extractions.length} 条（${text}）`);
  }
}

function printExtraction(out, extraction) {
  const payload = extraction.payload || {};
  out(`${extraction.extraction_id}  [${KIND_TEXT[extraction.kind] || extraction.kind}]  ${extraction.status}`);
  if (extraction.kind === 'requirement') {
    out(`  原文：${payload.raw_text}`);
    if (payload.claimed_level) out(`  自报等级：${payload.claimed_level}`);
  } else if (extraction.kind === 'convention') {
    out(`  约定：${payload.name}（${(payload.rules || []).length} 条规则）`);
    for (const rule of payload.rules || []) {
      out(`    - [${rule.severity}] ${rule.key}：${rule.title}`);
    }
  } else {
    out(`  议题：${payload.question}`);
    if (payload.chosen) out(`  倾向：${payload.chosen}`);
    if (payload.pending_decision) out('  已转为承载需求，待正式决定');
  }
  if (payload.source_quote) out(`  出处：${payload.source_quote}`);
  if (extraction.accepted_ref) out(`  已生成：${extraction.accepted_ref}`);
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    if (sub === 'add') {
      const content = flags.file ? readText(requireFlag(flags, 'file')) : requireFlag(flags, 'text');
      const created = await api.createMaterial({
        project_id: requireFlag(flags, 'project'),
        title: requireFlag(flags, 'title'),
        kind: requireFlag(flags, 'kind'),
        content,
        source_ref: optionalFlag(flags, 'source'),
        created_by: requireFlag(flags, 'by'),
      }, options);
      printMaterial(out, created);
      return 0;
    }
    if (sub === 'list') {
      const rows = await api.listMaterials({
        project_id: requireFlag(flags, 'project'),
        kind: optionalFlag(flags, 'kind'),
      }, options);
      if (!rows.length) { out('该项目还没有材料'); return 0; }
      rows.forEach((row) => printMaterial(out, row));
      return 0;
    }
    if (sub === 'show') {
      printMaterial(out, await api.getMaterial(requireFlag(flags, 'material'), options));
      return 0;
    }
    if (sub === 'extract') {
      const kinds = optionalFlag(flags, 'kinds');
      const result = await api.extractMaterial(requireFlag(flags, 'material'), {
        kinds: kinds ? kinds.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
        created_by: requireFlag(flags, 'by'),
      }, options);
      out(`提取完成：${result.extractions.length} 条草稿（未生效）`);
      for (const extraction of result.extractions) {
        out('');
        printExtraction(out, extraction);
      }
      if (result.uncertainties && result.uncertainties.length) {
        out('');
        out('未决项：');
        result.uncertainties.forEach((item) => out(`  - ${item}`));
      }
      return 0;
    }
    if (sub === 'accept') {
      const result = await api.acceptExtraction(requireFlag(flags, 'extraction'), {
        actor: requireFlag(flags, 'by'),
      }, options);
      const created = result.created || {};
      const ref = created.requirement_id || created.pack_id || '(未知)';
      out(`已采纳 ${result.kind}：${ref}`);
      if (result.kind === 'decision') out('注意：决定草稿已转为承载需求，请走正式决定流程。');
      return 0;
    }
    if (sub === 'reject') {
      const updated = await api.rejectExtraction(requireFlag(flags, 'extraction'), {
        actor: requireFlag(flags, 'by'),
        reason: requireFlag(flags, 'reason'),
      }, options);
      out(`已拒绝：${updated.extraction_id}`);
      return 0;
    }
    err('用法：sap material add|list|show|extract|accept|reject（详见 --help）');
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}

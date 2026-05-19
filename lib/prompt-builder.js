// BOSS Sniffer - prompt-builder.js (v0.12.0)
// 「必要条件 + 可选条件 + 阈值」prompt 拼装器
//
// 三段式：
//   段 1：角色 + JD 名称（一行）
//   段 2：岗位规则 = 必要条件列表 + 可选条件列表（无 JD 完整描述子段）
//   段 3：信息源优先级（静态）+ 决策规则（动态：M/N/K 替换）+ 输出 schema（动态：M1..M_n / O1..O_n）
//
// id 设计：
//   storage 层用 nanoid 稳定 id（jd.mustConditions[i].id）
//   prompt 层用 M1/M2/.../O1/O2/...（按数组顺序），减少 LLM 输出 token + prompt 整齐
//
// 公开 API：self.BossPromptBuilder.build(jd) → 完整 SYSTEM_PROMPT 字符串

(function (global) {
  'use strict';

  // 主入口
  function build(jd) {
    if (!jd || typeof jd !== 'object') {
      throw new Error('PromptBuilder.build: jd 不能为空');
    }
    const must = Array.isArray(jd.mustConditions) ? jd.mustConditions : [];
    const opt = Array.isArray(jd.optionalConditions) ? jd.optionalConditions : [];
    const K = Number(jd.optionalThreshold);
    const Kn = Number.isInteger(K) && K >= 0 ? K : 0;
    if (must.length === 0 && opt.length === 0) {
      throw new Error('PromptBuilder.build: jd 必须至少有一项 must 或 optional');
    }

    return [
      '你是 BOSS 直聘 HR 助手，针对「' + (jd.name || '未命名岗位') + '」岗位评估候选人。',
      '',
      buildConditionsSection(must, opt, Kn),
      buildSourcePrioritySection(),
      buildDecisionRuleSection(must, opt, Kn),
      buildOutputSchemaSection(must, opt)
    ].join('\n');
  }

  // === 段 2：岗位规则（动态）===
  function buildConditionsSection(must, opt, K) {
    const lines = ['# 岗位规则', ''];
    if (must.length > 0) {
      lines.push('## 必要条件（任一不满足或信息不足 → pass）');
      must.forEach(function (m, i) {
        lines.push('- M' + (i + 1) + '. ' + m.text);
      });
      lines.push('');
    }
    if (opt.length > 0) {
      lines.push('## 可选条件（需满足 ≥ ' + K + ' 个）');
      opt.forEach(function (o, i) {
        lines.push('- O' + (i + 1) + '. ' + o.text);
      });
      lines.push('');
    }
    return lines.join('\n');
  }

  // === 段 3a：信息源优先级（静态）===
  // v0.12.0 泛化：原 S5 prompt 末句"chat 改写国籍/阶段/能力时按 chat 走"绑定印尼语实习生场景，
  // 对测试工程师 / AI CX 等新 JD 无意义，改成不绑定具体字段的通用表述。
  function buildSourcePrioritySection() {
    return [
      '# 信息源优先级',
      '- chatHistory（候选人在 BOSS 对话框发的消息）：最高，最新最真',
      '- domDetail（沟通页详情面板 DOM 实际显示文本，v0.17.0.10 起）：次高。BOSS UI 显示什么就是什么；与简历字段冲突时按 DOM 走（DOM 是候选人实际填的多城市/长文本，接口字段是结构化简化版）',
      '- 简历各字段（basic / workHistory / education / expectation）：再次之',
      '- bossSignals（Boss 算法猜的高亮词）：最低',
      '冲突时取高优先级；chat 改写简历字段时按 chat 走（候选人在 chat 里说的话最新最真）。所有 evidence 都要纳入考量，低优先级不能直接忽视。',
      ''
    ].join('\n');
  }

  // === 段 3b：决策规则（半动态，M/N/K 替换）===
  function buildDecisionRuleSection(must, opt, K) {
    const mSet = must.length > 0
      ? must.map(function (_, i) { return 'M' + (i + 1); }).join(', ')
      : '(空)';
    const oSet = opt.length > 0
      ? opt.map(function (_, i) { return 'O' + (i + 1); }).join(', ')
      : '(空)';

    const lines = [
      '# 决策规则（机械执行，不得偏差）',
      '',
      '设必要条件集合 M = {' + mSet + '}',
      '设可选条件集合 O = {' + oSet + '}',
      '设可选阈值 K = ' + K,
      '',
      '1. 对每个 m ∈ M, 判断 m.value ∈ [true, false, "unknown"]',
      '2. 对每个 o ∈ O, 判断 o.value ∈ [true, false, "unknown"]',
      '3. 若 ∃ m ∈ M 使 m.value !== true → decision = "pass"',
      '4. 否则 satisfied = O.filter(o => o.value === true).length',
      '5. 若 satisfied >= ' + K + ' → decision = "符合"; 否则 decision = "pass"',
      '',
      '换句话说：**有任何必要条件未明确通过、或可选满足数未达阈值 → decision = "pass"**。只有"必要全 true 且可选 ≥ K"才输出"符合"。',
      '没有"不确定"决策态——LLM 拿不准的统一归 pass。',
      '',
      '**判 unknown 规则（不要脑补）**：',
      '- 简历相关字段缺失 / 模糊 → "unknown"',
      '- bossSignals 高亮词不算证据（最低优先级）',
      '- chatHistory 没提到也别推断',
      '- yearsOfExperience 字段如 "25届应届"、"在校生"、"3年" 都暗示学历阶段；26 届应届（≤2026.6）= 大四 / 已毕业边缘；27 届应届 = 大三',
      '',
      '**特殊判定细则 — 地址 / base 类条件（覆盖通则）**：',
      '若 must 文本涉及"地址 / base / 城市 / 工作地 / 居住"等地点类条件（例如"地址在南宁"、"base 在广州"）：',
      '- **只看**两个字段：`candidate.basic.city`（候选人现居城市）和 `candidate.expectation.cityName`（候选人期望工作城市）',
      '- **不看** `candidate.workHistory[].company` 包含的地名（工作经历地点不算 base、不算简历地址）',
      '- **不看** `candidate.chatHistory` 里候选人提到的城市（避免推断）',
      '- 任一字段文本包含 must 要求的任一关键词 → must.value = true',
      '- 两字段都不含 must 关键词 → must.value = false（明确判 false，不要写 unknown）',
      '- 两字段都为 null → must.value = unknown',
      '- 注意：`expectation.cityName` 当前可能只是候选人多个期望城市中的一个（接口层只返回单值），若它命中要求即视作通过',
      '',
      '**禁止逻辑错误（违反就是 bug）**：',
      '- ❌ 任一 must.value = "unknown" 但 decision = "符合"',
      '- ❌ 任一 must.value = false 但 decision = "符合"',
      '- ❌ optional satisfied < ' + K + ' 但 decision = "符合"',
      '- ❌ 用"看起来差不多"代替"明确证据"',
      ''
    ];
    return lines.join('\n');
  }

  // === 段 3c：输出 schema（动态，按 must/opt 数量生成 JSON 模板行）===
  function buildOutputSchemaSection(must, opt) {
    const lines = [
      '# 输出格式（严格）',
      '',
      '**只输出**纯 JSON 对象，从 `{` 开始到 `}` 结束。',
      '**严禁**：markdown 代码块（```json）/ JS 注释（// 或 /* */）/ 尾随逗号 / 前后散文。',
      '',
      '**最关键的指令（违反就直接判定失败）**：',
      '- 你的回复**必须以 `{` 字符为第一个字符**，**以 `}` 字符为最后一个字符**',
      '- 不允许：开头问候 / 解释 / 思考过程 / "好的"/"以下是"等任何前置文字 / markdown 代码块',
      '- 即使你认为信息不足，也必须完整输出 JSON——把不确定的 m.value 设为 "unknown" 即可，不要用大白话拒绝',
      '',
      '**reason 字段写法约束（重要）**：',
      '- must.reason 必须以 `M{n}.value=true/false/unknown，因为<字段名>=<字段值>` 开头',
      '- optional.reason 必须以 `O{n}.value=true/false/unknown，因为<字段名>=<字段值>` 开头',
      '- 禁止使用：百分比（如"推断 70%"）/ "或..." / "可能" / "看起来" / "缺少地址信息" 等 hedge 措辞',
      '- 引用字段值时用「中文引号」包裹',
      '',
      '**reason 字段内的引号规则（重要）**：reason 字段是 JSON 字符串，**不能含未转义的半角双引号** "。',
      '若需引用候选人原话或字段值，请用以下三种方式之一：',
      '- 中文引号「」或『』，例：reason: "候选人 desc 写「5 年 SaaS 销售经验」"',
      '- 单引号 \\\'，例：reason: "候选人 desc 写 \\\'5 年 SaaS\\\' 经验"',
      '- 不引用，直接陈述事实',
      '',
      '**字段顺序**：先 mustBreakdown → 再 optionalBreakdown → 再 decision → 最后 reason。**这个顺序非常重要**——必须先有条件判断再有决策。',
      '',
      '结构：',
      '{'
    ];

    // mustBreakdown
    if (must.length === 0) {
      lines.push('  "mustBreakdown": {},');
    } else {
      lines.push('  "mustBreakdown": {');
      must.forEach(function (_, i) {
        const isLast = i === must.length - 1;
        lines.push('    "M' + (i + 1) + '": { "value": true 或 false 或 "unknown", "reason": "一句话证据，引用具体字段" }' + (isLast ? '' : ','));
      });
      lines.push('  },');
    }

    // optionalBreakdown
    if (opt.length === 0) {
      lines.push('  "optionalBreakdown": {},');
    } else {
      lines.push('  "optionalBreakdown": {');
      opt.forEach(function (_, i) {
        const isLast = i === opt.length - 1;
        lines.push('    "O' + (i + 1) + '": { "value": true 或 false 或 "unknown", "reason": "一句话证据" }' + (isLast ? '' : ','));
      });
      lines.push('  },');
    }

    lines.push('  "decision": "符合" 或 "pass",');
    lines.push('  "reason": "≤30 字最终决策理由"');
    lines.push('}');

    return lines.join('\n');
  }

  global.BossPromptBuilder = {
    build: build,
    // 子段单独导出，方便单测 / admin 调试拼装
    buildConditionsSection: buildConditionsSection,
    buildSourcePrioritySection: buildSourcePrioritySection,
    buildDecisionRuleSection: buildDecisionRuleSection,
    buildOutputSchemaSection: buildOutputSchemaSection
  };
})(typeof self !== 'undefined' ? self : window);

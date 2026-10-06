// Compiles content/grammar/*.txt (grammar skills + exercises) into content/grammar-skills.json and
// validates every exercise: each one must have exactly one defensible answer.
// Usage: node scripts/build-grammar.mjs        (exit code 1 if anything is invalid)
//
// Format (one exercise per line, fields separated by " | "):
//   ## <skillId> | <topic-slug> | <category> | <short title>
//   requires: <skillId>, <skillId>            optional: studied before this one (soft)
//   rule: <one-line rule shown as feedback>
//   ask: <instruction shown above every exercise of the skill>   optional (default per exercise type)
//   c  | prompt with ___ | English | opt / *correct / opt | [own feedback]      choose the form
//   t  | prompt with ___ (hint) | English | answer / alt answer | [own feedback]  type the form
//   o  | chunk / chunk / chunk | English | [also: chunk / chunk || …] | [own feedback]   build the sentence
//   o? | … same, sentence ends with "?"
//   m  | German sentence | question in English | option / *correct | [own feedback]  who does what?
// Chunks of "o" are written in the correct order and in mid-sentence spelling; the app shuffles
// them and capitalises the first word. Skill ids are <topicId><n> (topic 110 -> 1101, 1102 …) and
// must never be reused; exercise ids are "<skillId>:<line number within the skill>" so append new
// exercises at the end of a skill.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CATEGORIES = ['case', 'gender', 'verb_form', 'word_order', 'adjective_ending', 'preposition', 'pronoun', 'negation', 'tense', 'mood', 'other'];
const MIN_ITEMS = 8;

const norm = (s) => s.normalize('NFC').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  .replace(/[.,!?;:"„“”()–-]/g, ' ').replace(/\s+/g, ' ').trim();

export function loadGrammarSkills() {
  const topics = JSON.parse(readFileSync(join(root, 'content/grammar.json'), 'utf8')).topics;
  const topicBySlug = new Map(topics.map((t) => [t.slug, t]));
  const dir = join(root, 'content/grammar');
  const skills = [];
  const problems = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/);
    let skill = null;
    lines.forEach((raw, i) => {
      const where = `${file}:${i + 1}`;
      const line = raw.trim();
      if (!line || (line.startsWith('#') && !line.startsWith('##'))) return;
      const bad = (msg) => problems.push(`${where}: ${msg}`);
      if (line.startsWith('##')) {
        const [id, topic, category, title] = line.slice(2).split('|').map((s) => s.trim());
        const t = topicBySlug.get(topic);
        skill = { id: Number(id), topic, topicId: t?.id, cefr: t?.lvl, category, title, rule: '', requires: [], items: [], where };
        if (!Number.isInteger(skill.id)) bad(`bad skill id "${id}"`);
        if (!t) bad(`unknown topic "${topic}"`);
        else if (Math.floor(skill.id / 10) !== t.id) bad(`skill id ${id} must start with topic id ${t.id}`);
        if (!CATEGORIES.includes(category)) bad(`unknown category "${category}"`);
        if (!title) bad('missing title');
        skills.push(skill);
        return;
      }
      if (!skill) return bad('content before the first skill header');
      if (line.startsWith('rule:')) { skill.rule = line.slice(5).trim(); return; }
      if (line.startsWith('ask:')) { skill.ask = line.slice(4).trim(); return; }
      if (line.startsWith('requires:')) { skill.requires = line.slice(9).split(',').map((s) => Number(s.trim())).filter(Boolean); return; }
      const f = line.split(' | ').map((s) => s.trim());
      const [type, prompt, en] = f;
      const n = skill.items.length + 1;
      const item = { id: `${skill.id}:${n}`, type: type.replace('?', ''), prompt, en };
      if (!prompt || !en) return bad('missing prompt or English');
      if (type === 'c' || type === 'm') {
        const opts = (f[3] ?? '').split(' / ').map((s) => s.trim()).filter(Boolean);
        const correct = opts.filter((o) => o.startsWith('*'));
        item.options = opts.map((o) => o.replace(/^\*/, ''));
        item.answer = correct[0]?.slice(1);
        if (correct.length !== 1) bad(`needs exactly one *correct option (${opts.join(' / ')})`);
        if (item.options.length < 2 || item.options.length > 4) bad('needs 2–4 options');
        if (new Set(item.options.map(norm)).size !== item.options.length) bad('duplicate options');
        if (type === 'c' && (prompt.match(/___/g) ?? []).length !== 1) bad('choice prompt needs exactly one ___');
        if (f[4]) item.explain = f[4];
      } else if (type === 't') {
        const accepted = (f[3] ?? '').split(' / ').map((s) => s.trim()).filter(Boolean);
        item.answer = accepted[0];
        item.accepted = [...new Set(accepted.map(norm))];
        if (!accepted.length) bad('typed exercise needs an answer');
        if ((prompt.match(/___/g) ?? []).length !== 1) bad('typed prompt needs exactly one ___');
        if (f[4]) item.explain = f[4];
      } else if (type === 'o' || type === 'o?') {
        item.chunks = prompt.split(' / ').map((s) => s.trim());
        item.punct = type === 'o?' ? '?' : '.';
        item.answer = item.chunks.join(' ');
        let extra = f[3] ?? '';
        if (extra && !extra.startsWith('also:')) { item.explain = extra; extra = ''; }
        if (f[4]) item.explain = f[4];
        const alts = extra ? extra.slice(5).split('||').map((a) => a.split(' / ').map((s) => s.trim())) : [];
        item.alternatives = alts.map((a) => a.join(' '));
        if (item.chunks.length < 3) bad('sentence building needs at least 3 chunks');
        if (new Set(item.chunks.map(norm)).size !== item.chunks.length) bad('chunks must be distinct');
        const key = (a) => [...a].map(norm).sort().join('|');
        for (const a of alts) if (key(a) !== key(item.chunks)) bad(`alternative order uses different chunks: ${a.join(' / ')}`);
        item.prompt = '';
      } else {
        return bad(`unknown exercise type "${type}"`);
      }
      if (skill.items.some((x) => x.type === item.type && norm(x.prompt + (x.chunks ?? []).join(' ')) === norm(item.prompt + (item.chunks ?? []).join(' ')))) bad('duplicate exercise in this skill');
      skill.items.push(item);
    });
  }
  const ids = new Set();
  for (const s of skills) {
    if (ids.has(s.id)) problems.push(`${s.where}: duplicate skill id ${s.id}`);
    ids.add(s.id);
    if (!s.rule) problems.push(`${s.where}: skill ${s.id} has no rule`);
    if (s.items.length < MIN_ITEMS) problems.push(`${s.where}: skill ${s.id} has ${s.items.length} exercises (min ${MIN_ITEMS})`);
  }
  for (const s of skills) for (const r of s.requires) if (!ids.has(r)) problems.push(`${s.where}: requires unknown skill ${r}`);
  for (const t of topics) if (!skills.some((s) => s.topic === t.slug)) problems.push(`topic ${t.slug} has no skills`);
  return { skills: skills.map(({ where, ...s }) => s), problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { skills, problems } = loadGrammarSkills();
  for (const p of problems) console.error('PROBLEM', p);
  const out = join(root, 'content/grammar-skills.json');
  writeFileSync(out, JSON.stringify({ _generated: 'by scripts/build-grammar.mjs from content/grammar/*.txt; do not edit', skills }, null, 1) + '\n');
  const items = skills.reduce((n, s) => n + s.items.length, 0);
  const byType = {};
  for (const s of skills) for (const i of s.items) byType[i.type] = (byType[i.type] ?? 0) + 1;
  const byLevel = {};
  for (const s of skills) byLevel[s.cefr] = (byLevel[s.cefr] ?? 0) + 1;
  console.log(`wrote ${out}: ${skills.length} skills, ${items} exercises`, byType, byLevel);
  if (problems.length) process.exit(1);
}

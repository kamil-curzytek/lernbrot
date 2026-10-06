// Quality gates for the grammar skills/exercises and unit tests for the grammar engine.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGrammarSkills as compile } from '../scripts/build-grammar.mjs';
import {
  buildExercise, isGrammarCorrect, pickItem, practiceQueue, scheduleGrammar, solvedSentence,
  type GrammarItem, type GrammarSkill,
} from '../src/lib/grammar';
import { genderHint } from '../src/lib/quiz/questions';
import { normalizeAnswer } from '../src/lib/quiz/text';

const { skills: compiled, problems } = compile() as unknown as { skills: GrammarSkill[]; problems: string[] };
const skills = compiled;
const all = skills.flatMap((s) => s.items.map((i) => ({ s, i })));
const topics = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'content', 'grammar.json'), 'utf8')).topics as { slug: string; lvl: string }[];

describe('grammar content', () => {
  it('compiles without problems, and the committed JSON is up to date', () => {
    expect(problems).toEqual([]);
    const json = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'content', 'grammar-skills.json'), 'utf8'));
    expect(json.skills, 'run: node scripts/build-grammar.mjs').toEqual(compiled);
  });

  it('covers every lesson topic A1–B2 with at least one skill of 8+ exercises', () => {
    for (const t of topics) {
      const own = skills.filter((s) => s.topic === t.slug);
      expect(own.length, t.slug).toBeGreaterThanOrEqual(1);
      for (const s of own) expect(s.items.length, `${s.id}`).toBeGreaterThanOrEqual(8);
    }
    expect(all.length).toBeGreaterThanOrEqual(600);
  });

  it('every exercise has an English translation and a rule to explain mistakes', () => {
    for (const { s, i } of all) {
      expect(i.en.length, i.id).toBeGreaterThan(2);
      expect((i.explain ?? s.rule).length, i.id).toBeGreaterThan(10);
    }
  });

  it('choice exercises: the right answer is one of the options, options are distinct', () => {
    for (const { s, i } of all.filter((x) => x.i.type === 'c' || x.i.type === 'm')) {
      const ex = buildExercise(s, i, 'seed');
      expect(ex.options, i.id).toContain(ex.correctAnswer);
      expect(new Set(ex.options!.map(normalizeAnswer)).size, i.id).toBe(ex.options!.length);
      expect(isGrammarCorrect(ex, ex.correctAnswer), i.id).toBe(true);
      for (const o of ex.options!) if (o !== ex.correctAnswer) expect(isGrammarCorrect(ex, o), `${i.id}: ${o}`).toBe(false);
    }
  });

  it('typed exercises accept their own answer, also typed without umlauts', () => {
    for (const { s, i } of all.filter((x) => x.i.type === 't')) {
      const ex = buildExercise(s, i, 'seed');
      expect(isGrammarCorrect(ex, i.answer), i.id).toBe(true);
      expect(isGrammarCorrect(ex, i.answer.toUpperCase()), i.id).toBe(true);
      expect(isGrammarCorrect(ex, i.answer.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')), i.id).toBe(true);
      expect(isGrammarCorrect(ex, 'xyz'), i.id).toBe(false);
    }
  });

  it('sentence building: shown shuffled, the right order and listed alternatives are accepted, others are not', () => {
    for (const { s, i } of all.filter((x) => x.i.type === 'o')) {
      const ex = buildExercise(s, i, 'seed');
      expect(ex.chunks, i.id).not.toEqual(i.chunks);
      expect([...ex.chunks!].sort(), i.id).toEqual([...i.chunks!].sort());
      expect(isGrammarCorrect(ex, i.chunks!.join(' ')), i.id).toBe(true);
      for (const alt of i.alternatives ?? []) expect(isGrammarCorrect(ex, alt), `${i.id}: ${alt}`).toBe(true);
      const reversed = [...i.chunks!].reverse().join(' ');
      if (![i.answer, ...(i.alternatives ?? [])].map(normalizeAnswer).includes(normalizeAnswer(reversed))) {
        expect(isGrammarCorrect(ex, reversed), i.id).toBe(false);
      }
      expect(solvedSentence(ex), i.id).toMatch(/^[A-ZÄÖÜ].*[.?]$/);
    }
  });

  it('skill ids follow <topicId><n> and requirements point backwards in the curriculum', () => {
    const order = new Map(skills.map((s, k) => [s.id, k]));
    for (const s of skills) {
      expect(Math.floor(s.id / 10), `${s.id}`).toBe(s.topicId);
      for (const r of s.requires) expect(order.get(r)!, `${s.id} requires ${r}`).toBeLessThan(order.get(s.id)!);
    }
  });
});

describe('grammar engine', () => {
  const skill = skills.find((s) => s.items.some((i) => i.type === 'c'))!;
  const item = skill.items.find((i) => i.type === 'c') as GrammarItem;

  it('is deterministic per seed and exercise ids encode skill + item', () => {
    expect(buildExercise(skill, item, 'a')).toEqual(buildExercise(skill, item, 'a'));
    expect(buildExercise(skill, item, 'a').id).toBe(`g${item.id}`);
  });

  it('pickItem rotates through all exercises of a skill over successive reviews', () => {
    const seen = new Set(Array.from({ length: skill.items.length }, (_, k) => pickItem(skill, 'session-1', k).id));
    expect(seen.size).toBe(skill.items.length);
  });

  it('practiceQueue contains every exercise once', () => {
    const q = practiceQueue(skill, 'x');
    expect(q.length).toBe(skill.items.length);
    expect(new Set(q.map((i) => i.id)).size).toBe(skill.items.length);
  });

  it('schedules with FSRS: recall-type exercises count more than choosing an option', () => {
    const ctx = { now: new Date('2026-10-07T18:00:00Z'), timeZone: 'Europe/Berlin' };
    const choice = buildExercise(skill, item, 's');
    const orderSkill = skills.find((s) => s.items.some((i) => i.type === 'o'))!;
    const order = buildExercise(orderSkill, orderSkill.items.find((i) => i.type === 'o')!, 's');
    const a = scheduleGrammar(null, choice, true, ctx);
    const b = scheduleGrammar(null, order, true, ctx);
    expect(b.stability).toBeGreaterThan(a.stability);
    const wrong = scheduleGrammar(null, order, false, ctx);
    expect(wrong.intervalDays).toBe(1);
  });

  it('gender hints only for reliable endings, and only when they agree with the article', () => {
    expect(genderHint({ german: 'Wohnung', article: 'die' })).toMatch(/-ung are die/);
    expect(genderHint({ german: 'Einbürgerung', article: 'die' })).toMatch(/-ung/);
    expect(genderHint({ german: 'Tisch', article: 'der' })).toBeUndefined();
    expect(genderHint({ german: 'Sprung', article: 'der' })).toBeUndefined(); // exception: rule not shown
    expect(genderHint({ german: 'Mutter', article: 'die' })).toBeUndefined(); // -er is unreliable: never shown
  });
});

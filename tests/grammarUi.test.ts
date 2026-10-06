// Render smoke tests for the grammar screens (no browser needed): every exercise format, answered and
// unanswered, plus the lesson practice list and the results card. Catches render-time crashes and
// checks that wrong answers show the rule and a lesson link.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { loadGrammarSkills as compile } from '../scripts/build-grammar.mjs';
import { GrammarExerciseView } from '../src/components/grammar/GrammarExerciseView';
import { SkillPractice } from '../src/components/grammar/SkillPractice';
import { QuizResults } from '../src/components/quiz/QuizResults';
import { buildExercise, type GrammarSkill } from '../src/lib/grammar';
import type { GrammarProgress } from '../src/types';

const skills = (compile() as unknown as { skills: GrammarSkill[] }).skills;
const byId = new Map(skills.map((s) => [s.id, s]));
const render = (el: (props: any) => unknown, props: object) => renderToStaticMarkup(h(MemoryRouter, null, h(el as any, props)));
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('grammar exercise view', () => {
  for (const type of ['c', 't', 'o', 'm'] as const) {
    const skill = skills.find((s) => s.items.some((i) => i.type === type))!;
    const item = skill.items.find((i) => i.type === type)!;
    const ex = buildExercise(skill, item, 'ui');

    it(`renders a ${type} exercise unanswered`, () => {
      const html = render(GrammarExerciseView, { exercise: ex, answer: undefined, onAnswer: () => {} });
      expect(strip(html)).toContain(ex.helper);
      if (ex.format === 'order') for (const c of ex.chunks!) expect(strip(html)).toContain(c.replace(/'/g, "'"));
      if (ex.format === 'choice') for (const o of ex.options!) expect(strip(html)).toContain(o);
      expect(html).not.toContain('feedback');
    });

    it(`renders a wrong ${type} answer with the solution, the rule and a lesson link`, () => {
      const html = render(GrammarExerciseView, { exercise: ex, answer: 'definitely wrong', onAnswer: () => {}, linkToLesson: true });
      const text = strip(html);
      expect(text).toContain('Correct:');
      expect(text).toContain(ex.explanation);
      expect(html).toContain(`/grammar/${ex.topic}`);
    });

    it(`renders a correct ${type} answer`, () => {
      const right = ex.format === 'order' ? item.chunks!.join(' ') : ex.correctAnswer;
      const html = render(GrammarExerciseView, { exercise: ex, answer: right, onAnswer: () => {} });
      expect(strip(html)).toContain('✓ Correct');
    });
  }
});

describe('lesson practice list', () => {
  it('lists the skills of a lesson, marks studied ones, and notes prerequisites', () => {
    const own = skills.filter((s) => s.topic === 'subordinate-clauses');
    const progress = new Map<number, GrammarProgress>([[own[0].id, { skill_id: own[0].id, status: 'familiar' } as GrammarProgress]]);
    const text = strip(render(SkillPractice, { skills: own, progress, allSkills: byId }));
    for (const s of own) expect(text).toContain(s.title);
    expect(text).toContain('Practise again');
    expect(text).toContain('familiar');
    expect(text).toContain('Easier after:'); // 2023 requires 1042, not studied here
  });
});

describe('results card', () => {
  it('shows the grammar score and links the missed rules to their lessons', () => {
    const skill = skills[0];
    const ex = buildExercise(skill, skill.items[0], 'r');
    const html = render(QuizResults, {
      score: 8, total: 10, words: [], incorrectWordIds: [], dailyTarget: 10,
      grammar: { score: 1, total: 2, wrong: [ex] },
    });
    expect(strip(html)).toContain('Grammar: 1 / 2');
    expect(html).toContain(`/grammar/${skill.topic}`);
  });
});

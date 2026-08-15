// "How far through this course is the member?" — one answer for every course,
// whatever it is built out of.
//
// Every course now stores progress the same way:
//   users/{uid}/progress/{slug}__m{id}  (course-renderer.js)
// Anything that only needs "is this finished, and how far in are they" — the
// roadmap, the certificate — should go through this module rather than reach
// into storage itself.

import { loadModulesMeta } from './courses-data.js';

async function firestoreCompleted(slug) {
  try {
    const { loadCourseProgress } = await import('./course-renderer.js');
    return await loadCourseProgress(slug);
  } catch (e) {
    return new Set();
  }
}

/**
 * Completion state for one course:
 *   { modules, completed:Set, done, total, pct, isComplete }
 *
 * `done` counts only modules that actually exist in the course today, so a
 * progress doc left behind by a deleted lesson can never push a member to 100%.
 */
export async function loadCourseCompletion(course, { includeDrafts = false } = {}) {
  const empty = { modules: [], completed: new Set(), done: 0, total: 0, pct: 0, isComplete: false };
  if (!course) return empty;

  const modules = await loadModulesMeta(course, { includeDrafts });

  const completed = await firestoreCompleted(course.slug);

  const total = modules.length;
  const done = modules.filter((m) => completed.has(m.id)).length;
  return {
    modules,
    completed,
    done,
    total,
    pct: total ? Math.round((done / total) * 100) : 0,
    isComplete: total > 0 && done === total
  };
}

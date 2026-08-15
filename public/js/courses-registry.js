// Course registry — the seed catalog.
//
// This file exists for courses that ship in code. It starts EMPTY on purpose:
// the recommended way to build a course is through the admin CMS at
// /manage-courses.html (Quill editor → course-builder.js → course-uploads.js,
// rendered by course-renderer.js), or via the AI generator in course-ai.js.
// Nothing here needs to be filled in for the catalog to work.
//
// ─── How the merge works (see courses-data.js) ───────────────────────────────
// Every entry below is a SEED DEFAULT. Firestore `courses/{slug}` fields
// override it field by field, and Firestore-only documents are appended and
// rendered by the generic renderer. That is what lets an admin edit the catalog
// without a deploy.
//
// `mount` is a function, so it can only ever come from code — Firestore cannot
// store one. A course needs `mount` ONLY if it is authored in code. Leave it
// off and the generic renderer handles the course.
//
// ─── Entry schema ────────────────────────────────────────────────────────────
//   {
//     slug:           'your-course',   // Firestore doc ID. Renaming later is a
//                                      // data migration — pick it carefully.
//     title:          'Course title',
//     eyebrow:        'Certification', // small label above the title
//     price:          497,             // dollars, or null for free
//     salePrice:      null,            // dollars, or null
//     status:         'live',          // 'live' | 'coming-soon' | 'inactive'
//     description:    'One paragraph, rendered on the landing page.',
//     curriculum:     [ { title: 'Section', lessons: [ { t, d, kind } ] } ],
//     whatYoullLearn: [ 'Outcome one', 'Outcome two' ],
//     requirements:   [ 'What a learner needs before starting' ],
//     includes:       [ 'What comes with enrollment' ],
//     mount:          optionalFn       // code-authored courses only
//   }
//
// Lesson `kind` is optional and only affects the icon: 'practice' | 'assessment'.

export const COURSES = [];

// Returns the active course if ?course=<slug> matches a known course, else null
// (null = library view). No course is auto-selected; users land on the library
// and pick one explicitly.
export function getActiveCourse() {
  const slug = new URLSearchParams(location.search).get('course');
  if (!slug) return null;
  return COURSES.find((c) => c.slug === slug) || null;
}

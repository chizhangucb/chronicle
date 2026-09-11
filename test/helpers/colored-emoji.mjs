// The ONE definition of "colored emoji" for this repo's glyph invariant, shared
// by test/no-colored-emoji.test.mjs (the app-wide sweep) and
// test/kind-icons.test.mjs (the message-kind glyphs). Same reason
// test/helpers/tracked-files.mjs and test/helpers/retired-vocabulary.mjs exist:
// two copies of a sweep drifted apart once already (issue #186), and a second
// definition of the line between mono and colored is exactly the kind of thing
// that drifts.
//
// The line is \p{Emoji_Presentation}: a code point a renderer draws as the COLOR
// emoji glyph by default, with no variation selector asked for. That is the
// rubric's "zero colored emoji" read precisely, and it is why the canonical mono
// set passes it — those code points are Emoji=Yes but text-presentation by
// default, so they draw as type in the surrounding line. Matching
// \p{Extended_Pictographic} instead would condemn the whole canonical set.

/** Matches any code point whose DEFAULT rendering is the color emoji glyph. */
export const COLORED_EMOJI = /\p{Emoji_Presentation}/u;

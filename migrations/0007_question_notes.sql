-- WTP Question Rank: a question's published footnotes (owner decision, 25 Nov 2026; see DEVIATIONS.md).
-- CCE prints a source note under a question whose stem or bullets quote someone, with an asterisk in the text.
-- notes_json holds them as published: {"marks": [[part, offset, mark], ...], "notes": [{"mark": "*", "text": "..."}, ...]}
-- where part 0 is the stem and 1, 2 the bullets, and offset is where the mark stands in that text.
-- Rules:
--   * The stem and bullets are unchanged and still immutable (and still hashed without their marks).
--   * notes_json is display material, not question text: it may be filled in or corrected after a question is loaded.
--   * NULL means the notes have not been loaded; '{"marks":[],"notes":[]}' means the question has none.

ALTER TABLE questions ADD COLUMN notes_json TEXT;

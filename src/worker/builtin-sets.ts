// The item set that ships with the site: every published question in one round (owner decision, 25 Nov 2026), built by
// items/build_round_sets.py from CCE's published PDFs (items/transcribe.py). Admin only: the file holds question ids,
// cycles and units, so it is bundled into the Worker and never served as a static file.
import all from "../../items/rounds/all.json";

interface SetFile {
  item_set: string;
  version: number;
  round_name: string;
  frame: string;
  items: unknown[];
}

export const BUILTIN_SETS = ([all] as SetFile[]).map((file) => ({
  id: `${file.item_set}-v${file.version}`,
  roundName: file.round_name,
  questions: file.items.length,
  cycles: file.frame,
  file,
}));

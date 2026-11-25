// The item sets that ship with the site: one per unit and level, built by items/build_round_sets.py from CCE's
// published PDFs (items/transcribe.py). Admin only: these files hold question ids, cycles and units, so they are
// bundled into the Worker and never served as static files.
import nfU1 from "../../items/rounds/nf-u1.json";
import nfU2 from "../../items/rounds/nf-u2.json";
import nfU3 from "../../items/rounds/nf-u3.json";
import nfU4 from "../../items/rounds/nf-u4.json";
import nfU5 from "../../items/rounds/nf-u5.json";
import nfU6 from "../../items/rounds/nf-u6.json";
import stU1 from "../../items/rounds/state-u1.json";
import stU2 from "../../items/rounds/state-u2.json";
import stU3 from "../../items/rounds/state-u3.json";
import stU4 from "../../items/rounds/state-u4.json";
import stU5 from "../../items/rounds/state-u5.json";
import stU6 from "../../items/rounds/state-u6.json";

interface SetFile {
  item_set: string;
  version: number;
  round_name: string;
  cycles: string[];
  items: unknown[];
}

export const BUILTIN_SETS = ([stU1, stU2, stU3, stU4, stU5, stU6, nfU1, nfU2, nfU3, nfU4, nfU5, nfU6] as SetFile[]).map((file) => ({
  id: `${file.item_set}-v${file.version}`,
  roundName: file.round_name,
  questions: file.items.length,
  cycles: `${file.cycles[0]} to ${file.cycles[file.cycles.length - 1]}`,
  file,
}));

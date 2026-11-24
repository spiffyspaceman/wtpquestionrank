# WTP Question Rank: notes for Claude

- When the owner asks for "next steps", read `docs/NEXT_STEPS.md`, answer from it, and keep it current.
- Never edit the frozen files listed in `README.md`. The pre-registration hashes them and a test enforces that.
- This project shares nothing with the owner's news reader (`reader.spiffyspaceman.com`, repo `spiffyspaceman/reader`,
  Worker `reader-email`). Don't read or touch any of it.
- Ask the owner before any outward step: Cloudflare settings, DNS, secrets, or anything that changes production data.
  A push to `main` deploys.
- No analytics, no third-party scripts except Turnstile, no emojis. Store no names, emails or free text from voters.

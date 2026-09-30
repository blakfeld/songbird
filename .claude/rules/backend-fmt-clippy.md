# Format and lint every backend change

Any change under `backend/` is not done until both of these pass, run from `backend/`:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
```

- Run them after every backend edit, however small, before reporting the work as done or handing it to `code-reviewer`. `just lint` runs these same checks, so skipping them just pushes the failure to later.
- Fix every clippy warning. Add `#[allow(...)]` only when the lint is actually wrong for that code, and put a comment beside it saying why.
- When you delegate backend work, put both commands in the agent's definition of done and ask it to report whether they passed.

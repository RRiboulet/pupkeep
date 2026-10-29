# The pi config volume

`docker-compose.yml` mounts the named volume `pupkeep-pi-config` at
`/home/vscode/.pi`. That directory — not this one — holds the coding agent's
settings, sessions, model auth and the gh token. Mounting it is what makes
`gh auth login` and pi sessions survive a rebuild: `/home/vscode` itself is
container-local and is discarded.

The repo's `.pi/settings.json` is deliberately **not** part of this volume and is
deliberately not created by `postCreate.sh`. When pupkeep sits inside a workspace
that already loads the shared `my-agent-setup` extensions, declaring the package
here would load every extension twice and break subagent startup. The
`postCreate.sh` installs the package into the **personal** settings in the volume
instead, and skips it when the project already declares it.

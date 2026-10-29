#!/usr/bin/env node
// The server process. The launcher spawns this file with PUPKEEP_BIND_HOST,
// PUPKEEP_PORT and PUPKEEP_DATA_DIR. Everything worth testing lives in
// src/server/app.ts and src/server/harness.ts; this entry only hands over.

import { runMain } from "../src/server/main.ts";

runMain();

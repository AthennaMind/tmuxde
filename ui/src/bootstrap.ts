import { z } from "zod";

// Configure validation before loading modules that construct schemas.
z.config({ jitless: true });
void import("./main");

import { openaiSignIn } from "./openai.js";
import type { SignInFlow } from "./types.js";

/** Every flow a system may name in `signIn`. */
export const SIGN_IN_FLOWS: Readonly<Record<string, SignInFlow>> = { [openaiSignIn.id]: openaiSignIn };

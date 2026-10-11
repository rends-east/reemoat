import type { Untranslatable } from "../translate/types.js";
import { shapeForChatgptPlan } from "./chatgpt.js";

/** What a system reached by a sign-in asks of a request beyond its protocol, by the flow that signs it. */
export const SHAPES: Readonly<Record<string, (body: unknown) => { body: unknown } | Untranslatable>> = {
  "openai-siwc": shapeForChatgptPlan,
};

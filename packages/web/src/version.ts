/** `typeof` because `__APP_VERSION__` is undeclared under plain tsx (webcheck) and in the gate bundle; a bare reference throws. */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

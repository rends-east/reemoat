import { Reemoat, type ReemoatOptions } from "./client.js";
import { Boards, Tasks } from "./tasks.js";

export { Reemoat, type Answer, type ReemoatOptions, type RequestOptions } from "./client.js";
export { DeviceNotApproved, MachineKeyChanged, ReemoatError, isUnreachable, type ErrorWhere } from "./errors.js";
export { clientHome } from "./identity.js";
export { newTaskKey, type Board, type Listing, type NewTask, type Task } from "./tasks.js";
export type { MachineRow } from "./authority.js";

export interface ReemoatClient {
  readonly client: Reemoat;
  readonly tasks: Tasks;
  readonly board: Boards;
  machines: Reemoat["machines"];
  request: Reemoat["request"];
}

/** Signs in with the API key and answers a client; no machine is dialled until a call names one. */
export async function reemoat(options: ReemoatOptions): Promise<ReemoatClient> {
  const client = await Reemoat.connect(options);
  return {
    client,
    tasks: new Tasks(client),
    board: new Boards(client),
    machines: () => client.machines(),
    request: (machine, request) => client.request(machine, request),
  };
}

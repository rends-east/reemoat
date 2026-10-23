// One copy shared by the app and the daemon: a mirrored crypto protocol that drifts could quietly agree on something weaker.
// No Buffer or other Node global: packages/web typechecks with no Node types.
export {
  FRAME,
  LengthReader,
  MAX_FRAME_PAYLOAD,
  MAX_HEADER_JSON_BYTES,
  MAX_SOCKET_MESSAGE_BYTES,
  MessageAssembler,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  tryEncodeJsonFrame,
  type CloseFrame,
  type DeviceDescription,
  type FrameType,
  type HelloFrame,
  type OpenFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./frames.js";
export { approvalCode, keyFingerprint } from "./fingerprint.js";
export {
  ChannelExchange,
  requestProblem,
  type ChannelCarrier,
  type ChannelExchangeOptions,
  type ChannelOutcome,
  type ChannelRequest,
} from "./initiator.js";
export { readMachineKey, weighOfferedKey, type OfferedKey } from "./pins.js";
export {
  CipherState,
  generateStaticKey,
  localStaticKey,
  NoiseHandshake,
  publicFromSecret,
  randomSecretKey,
  type Ephemeral,
  type NoiseOptions,
  type NoiseTransport,
  type StaticKey,
} from "./noise.js";

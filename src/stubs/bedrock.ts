/**
 * Stand-in for the Bedrock SDK the harness imports and this extension never calls.
 * Any reach into it is a programming error, so every member throws.
 */
const refuse = (): never => {
  throw new Error("Bedrock is not available in the extension")
}

export const BedrockRuntimeClient = class {
  constructor() {
    refuse()
  }
}
export const ConverseStreamCommand = BedrockRuntimeClient
export const ConverseCommand = BedrockRuntimeClient
export const BedrockConverseTextAdapter = refuse
export const BEDROCK_CONVERSE_MODELS = [] as const
export default {}

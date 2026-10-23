/**
 * Failures in plain words: one sentence a person can read, made from what eNCode knows (the kind of failure, the
 * model and the provider), never from what a provider wrote. The provider's own text goes in a `detail`, for a
 * Details fold and a diagnostics report.
 */

/** A failure's kind: a transport error's kind, the router's refusal kinds, or one of its own. */
export interface PlainFailure {
  kind: string
  /** For `unsupported`: what the model lacks. */
  feature?: string
}

/** One sentence on what happened to `model` of `provider`. */
export function failureSentence(failure: PlainFailure, { model, provider }: { model: string; provider: string }): string {
  switch (failure.kind) {
    case 'no-key':
      return `There is no API key for ${provider}.`
    case 'key-read':
      return `eNCode could not read the API key for ${provider}.`
    case 'auth':
      return `${provider} did not accept the API key.`
    case 'payment':
      return `The ${provider} account is out of credit.`
    case 'quota':
      return `${provider}'s daily limit is used up.`
    case 'free-daily':
      return `The free models on ${provider} have used up today's requests.`
    case 'rate-limit':
      return `${model} is getting too many requests right now.`
    case 'free-rpm':
      return `The free models on ${provider} have reached their limit for the minute.`
    case 'overloaded':
      return `${model} is overloaded right now.`
    case 'server':
      return `${model} had a problem on the provider's side.`
    case 'timeout':
      return `${model} took too long to answer.`
    case 'network':
      return `eNCode could not reach ${provider}.`
    case 'context-overflow':
      return `The conversation is too long for ${model}.`
    case 'unsupported':
      switch (failure.feature) {
        case 'tools':
          return `${model} cannot use tools.`
        case 'images':
          return `${model} cannot read images.`
        case 'documents':
          return `${model} cannot read PDFs.`
        case 'stream':
          return `${model} cannot stream its replies.`
        default:
          return `${model} does not support this kind of request.`
      }
    case 'not-found':
      return `${provider} no longer offers ${model}.`
    case 'content-filter':
      return `The provider's safety filter stopped ${model}'s reply.`
    case 'invalid-request':
      return `${model} turned the request down.`
    case 'protocol':
      return `${model} sent a reply that broke off or could not be read.`
    case 'empty':
      return `${model} sent an empty reply.`
    case 'tool-json':
      return `${model} wrote tool calls that could not be read.`
    case 'policy':
      return `Your ${provider} privacy settings keep ${model} from eNCode.`
    case 'app-only':
      return `${provider} lets only the apps on its list use ${model}.`
    case 'forbidden':
      return `${provider} refused ${model} for this account.`
    case 'server-tool':
      return `Your ${provider} preset adds a tool that does not work with ${model} in eNCode.`
    default:
      return `${model} is not available right now.`
  }
}

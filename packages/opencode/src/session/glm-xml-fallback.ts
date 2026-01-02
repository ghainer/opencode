import type { LanguageModelMiddleware } from "ai"
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider"
import { Log } from "@/util/log"

const log = Log.create({ service: "glm-xml-fallback" })

interface ParsedToolCall {
  id: string
  type: "function"
  index: number
  function: {
    name: string
    arguments: string
  }
}

/**
 * Parse GLM XML tool call format into structured tool calls.
 *
 * GLM uses this specific XML format (NOT <invoke>/<function_name>/<argument_name>):
 * <tool_call>function_name<arg_key>argument_name</arg_key><arg_value>argument_value</arg_value></tool_call>
 */
export function parseGlmXmlToolCall(content: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = []

  // Match <tool_call>...</tool_call> blocks
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  let index = 0

  while ((match = toolCallRegex.exec(content)) !== null) {
    const innerContent = match[1]

    // Function name is RAW TEXT before first <arg_key>, NOT in a <function_name> tag
    const nameMatch = innerContent.match(/^([^<]+)/)
    const toolName = nameMatch ? nameMatch[1].trim() : ""

    if (!toolName) {
      continue // Skip malformed tool calls
    }

    // Extract all <arg_key>...</arg_key><arg_value>...</arg_value> pairs
    const args: Record<string, any> = {}
    const argRegex = /<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
    let argMatch

    while ((argMatch = argRegex.exec(innerContent)) !== null) {
      const key = argMatch[1].trim()
      let value: any = argMatch[2]

      // Try to parse as JSON if it looks like JSON
      if (
        (value.startsWith("{") && value.endsWith("}")) ||
        (value.startsWith("[") && value.endsWith("]"))
      ) {
        try {
          value = JSON.parse(value)
        } catch {
          // Keep as string if not valid JSON
        }
      }

      args[key] = value
    }

    toolCalls.push({
      id: `toolu_fallback_${Math.random().toString(36).slice(2)}`,
      type: "function",
      index: index++,
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    })
  }

  return toolCalls
}

/**
 * Check if the accumulated content indicates a failed GLM XML tool call.
 *
 * The fallback triggers when:
 * - finish_reason === "stop" (not "tool_calls")
 * - Accumulated content ends with </tool_call>
 *
 * Note: We don't check stop_reason because the AI SDK may not pass through
 * vLLM's custom stop_reason field to providerMetadata.
 */
function shouldTriggerFallback(
  finishReason: string | null | undefined,
  accumulatedContent: string,
): boolean {
  const endsWithToolCall = accumulatedContent.trimEnd().endsWith("</tool_call>")
  if (endsWithToolCall) {
    log.info("GLM fallback check", {
      finishReason,
      endsWithToolCall,
      contentTail: accumulatedContent.slice(-100),
    })
  }
  return finishReason === "stop" && endsWithToolCall
}

/**
 * Middleware that provides fallback parsing for GLM XML tool calls.
 *
 * When vLLM fails to parse GLM's native XML tool calls, this middleware
 * detects the failure and converts the raw XML into structured tool calls.
 */
export function glmXmlFallbackMiddleware(): LanguageModelMiddleware {
  log.info("GLM XML fallback middleware initialized")
  return {
    wrapStream: async ({ doStream }) => {
      log.info("GLM fallback: wrapping stream")
      const result = await doStream()

      let accumulatedContent = ""
      let hasToolCalls = false
      let finishReason: string | null | undefined = null
      let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined

      const transformStream = new TransformStream<
        LanguageModelV2StreamPart,
        LanguageModelV2StreamPart
      >({
        transform(chunk, controller) {
          // Track tool calls from the provider
          if (chunk.type === "tool-call") {
            hasToolCalls = true
            log.info("GLM fallback: provider sent tool-call, skipping fallback")
          }

          // Accumulate text content
          if (chunk.type === "text-delta") {
            accumulatedContent += chunk.delta
          }

          // Track finish reason
          if (chunk.type === "finish") {
            log.info("GLM fallback: stream finished", {
              finishReason: chunk.finishReason,
              hasToolCalls,
              contentLength: accumulatedContent.length,
              contentTail: accumulatedContent.slice(-100),
            })
            finishReason = chunk.finishReason
            usage = {
              inputTokens: chunk.usage.inputTokens ?? 0,
              outputTokens: chunk.usage.outputTokens ?? 0,
              totalTokens: chunk.usage.totalTokens ?? 0,
            }

            // Check if we need to apply fallback
            if (
              !hasToolCalls &&
              shouldTriggerFallback(finishReason, accumulatedContent)
            ) {
              const toolCalls = parseGlmXmlToolCall(accumulatedContent)

              if (toolCalls.length > 0) {
                log.info("GLM fallback triggered", {
                  toolName: toolCalls[0]?.function?.name,
                  numTools: toolCalls.length,
                })

                // Emit tool-call parts for each parsed tool call
                for (const tc of toolCalls) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: tc.id,
                    toolName: tc.function.name,
                    input: tc.function.arguments,
                  })
                }

                // Emit a corrected finish event with tool_calls reason
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: usage ?? {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                  },
                  // Remove stop_reason from provider metadata
                  providerMetadata: undefined,
                })

                return
              }
            }
          }

          // Pass through all chunks normally
          controller.enqueue(chunk)
        },
      })

      return {
        ...result,
        stream: result.stream.pipeThrough(transformStream),
      }
    },
  }
}

/**
 * Check if a model is a GLM model that may need XML fallback parsing.
 * Matches any model with "glm" in the name.
 */
export function isGlmModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("glm")
}

import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export const Event = {
  Connected: BusEvent.define("server.connected", z.object({})),
  Disposed: BusEvent.define("global.disposed", z.object({})),
  TuiStatusUpdated: BusEvent.define(
    "tui.status.updated",
    z.record(
      z.string(),
      z.object({
        id: z.string(),
        priority: z.number().optional(),
        long: z.object({
          icon: z.string().optional(),
          text: z.string(),
          color: z.enum(["default", "green", "yellow", "red", "blue", "gray"]).optional(),
          detail: z.string().optional(),
          progress: z.number().optional(),
          subtext: z.string().optional(),
        }),
        short: z
          .object({
            icon: z.string().optional(),
            text: z.string(),
            color: z.enum(["default", "green", "yellow", "red", "blue", "gray"]).optional(),
          })
          .nullable(),
      }),
    ),
  ),
}

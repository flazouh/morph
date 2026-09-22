import { expect, test } from "bun:test"
import { AWAKE_STEP_MS, waitAwake } from "./awake"

const recorder = () => {
  const waits: number[] = []
  let pings = 0
  return {
    waits,
    pings: () => pings,
    ports: {
      wait: async (milliseconds: number) => {
        waits.push(milliseconds)
      },
      ping: async () => {
        pings += 1
      }
    }
  }
}

test("a long wait is taken in steps short enough to keep the worker awake", async () => {
  const { waits, pings, ports } = recorder()
  await waitAwake(ports, 65_000)
  expect(waits.reduce((total, step) => total + step, 0)).toBe(65_000)
  expect(waits.every((step) => step <= AWAKE_STEP_MS)).toBe(true)
  expect(pings()).toBe(waits.length)
})

test("a short wait is one step and one ping", async () => {
  const { waits, pings, ports } = recorder()
  await waitAwake(ports, 5_000)
  expect(waits).toEqual([5_000])
  expect(pings()).toBe(1)
})

test("nothing to wait for is nothing to do", async () => {
  const { waits, pings, ports } = recorder()
  await waitAwake(ports, 0)
  expect(waits).toEqual([])
  expect(pings()).toBe(0)
})

test("a ping that fails does not end the wait", async () => {
  const waits: number[] = []
  await waitAwake(
    {
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
      ping: async () => {
        throw new Error("the worker is busy")
      }
    },
    45_000
  )
  expect(waits.reduce((total, step) => total + step, 0)).toBe(45_000)
})

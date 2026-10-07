export type Device = { index: number; name: string }

/** What the /intiface dialog shows: the step it is on, then the devices to pick from. */
export type DeviceDialog = { title: string; devices: Device[]; selected: number | null }

declare module 'claude-code' {
  interface PluginState {
    vibeclaude: { dialog: DeviceDialog }
  }
}

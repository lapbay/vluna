// HTTP DTOs for controllers

export type SamplePostBody = {
  title?: string
}

// External input; keep flexible but avoid `any`
export type ConsentBody = Record<string, unknown>


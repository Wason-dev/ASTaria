/** Visual tuning and sample data are development tools, never production settings. */
export const DESIGN_PREVIEW = import.meta.env.DEV || import.meta.env.MODE === 'design-preview'

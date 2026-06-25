export async function onRequestGet(context) {
  const projectId = context.env.GOOGLE_PROJECT_ID ?? ''
  return new Response(
    `export const GOOGLE_PROJECT_ID = ${JSON.stringify(projectId)};\n`,
    { headers: { 'Content-Type': 'application/javascript' } }
  )
}

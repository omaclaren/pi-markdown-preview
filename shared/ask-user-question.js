// Shapes used only for retrospective Claude AskUserQuestion presentation.
// No quote/comma parsing, inferred selections, Markdown, links or live controls.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function questionInput(value) {
 return object(value) && Array.isArray(value.questions) && value.questions.length >= 1 && value.questions.length <= 4
  && value.questions.every(q => object(q) && typeof q.question === 'string' && q.question.trim()
   && typeof q.header === 'string' && (q.multiSelect === undefined || typeof q.multiSelect === 'boolean')
   && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4
   && q.options.every(o => object(o) && typeof o.label === 'string' && typeof o.description === 'string'
    && (o.preview === undefined || typeof o.preview === 'string')));
}
export function questionAnswers(value) {
 return object(value) && object(value.answers) && Object.keys(value.answers).length <= 4
  && Object.values(value.answers).every(answer => typeof answer === 'string')
  && (value.annotations === undefined || (object(value.annotations) && Object.keys(value.annotations).length <= 4
   && Object.values(value.annotations).every(note => object(note)
    && Object.entries(note).every(([key, v]) => ['preview','notes'].includes(key) && typeof v === 'string'))));
}
// Project only the known answer fields, not unrelated transcript metadata.
export function recordedQuestionAnswers(value) {
 if (!questionAnswers(value)) return;
 return JSON.stringify({ answers: value.answers, ...(value.annotations === undefined ? {} : { annotations: value.annotations }) });
}

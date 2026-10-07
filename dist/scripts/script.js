const stageNotes = [
  "Настольная лампа — единственный предмет, который остаётся на своём месте во всех восьми сценах.",
  "Металлическая рама появилась вместо разметки на полу после четвёртой репетиции и сразу стала частью действия.",
  "После найденного письма актёры выдерживают семнадцать секунд тишины — это самая длинная пауза спектакля.",
  "Шум моря собран из шелеста бумаги, движения щётки по ткани и низкого звука старого вентилятора.",
  "В середине спектакля герои незаметно меняются плащами: так память одного впервые становится памятью другого.",
  "На премьере в зале стояло сорок два стула, а настольная лампа продолжала гореть после ухода последнего зрителя."
];

const noteText = document.querySelector("[data-note-text]");
const noteCounter = document.querySelector("[data-note-counter]");
const noteButton = document.querySelector("[data-note-next]");

let currentNoteIndex = 0;

function showNextNote() {
  currentNoteIndex = (currentNoteIndex + 1) % stageNotes.length;
  noteText.textContent = stageNotes[currentNoteIndex];
  noteCounter.textContent = `${String(currentNoteIndex + 1).padStart(2, "0")}/${String(stageNotes.length).padStart(2, "0")}`;
}

if (noteText && noteCounter && noteButton) {
  noteButton.addEventListener("click", showNextNote);
}

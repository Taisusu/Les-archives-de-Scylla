
const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

const normalize = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

async function supabase(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Configuration Supabase manquante.");
  }

  const response = await fetch(
    `${url}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: key,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const body = await response.text();

  if (!response.ok) {
    console.error("Erreur Supabase :", response.status, body);
    throw new Error("La base de données a refusé la requête.");
  }

  return body ? JSON.parse(body) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  try {
    const input = JSON.parse(event.body || "{}");

    // Récupérer les questions sans révéler les réponses
    if (input.action === "questions") {
      const chapterId = Number(input.chapterId);

      if (!Number.isSafeInteger(chapterId) || chapterId < 1) {
        return json(400, { error: "Chapitre invalide." });
      }

      const chapters = await supabase(
        `chapters?id=eq.${chapterId}&is_published=eq.true&select=id,title,volume_number,chapter_number`
      );

      if (!chapters.length) {
        return json(404, { error: "Chapitre indisponible." });
      }

      const questions = await supabase(
        `questions?chapter_id=eq.${chapterId}&select=id,question_number,question_text,question_type,options,is_double&order=question_number.asc`
      );

      return json(200, {
        chapter: chapters[0],
        questions,
      });
    }

    // Corriger et enregistrer une tentative après validation
    if (input.action === "submit") {
      const chapterId = Number(input.chapterId);
      const pseudo = String(input.pseudo || "").trim();
      const answers = input.answers;

      if (
        !Number.isSafeInteger(chapterId) ||
        chapterId < 1 ||
        pseudo.length < 1 ||
        pseudo.length > 50 ||
        !Array.isArray(answers) ||
        answers.length < 1 ||
        answers.length > 24
      ) {
        return json(400, { error: "Données invalides." });
      }

      const chapters = await supabase(
        `chapters?id=eq.${chapterId}&is_published=eq.true&select=id`
      );

      if (!chapters.length) {
        return json(404, { error: "Chapitre indisponible." });
      }

      const questions = await supabase(
        `questions?chapter_id=eq.${chapterId}&select=id,question_number,question_text,question_type,options,correct_answers,correct_answer_display,explanation,is_double&order=question_number.asc`
      );

      if (
        questions.length === 0 ||
        answers.length !== questions.length
      ) {
        return json(400, {
          error: "Le nombre de réponses ne correspond pas au quiz.",
        });
      }

      const submitted = new Map();

      for (const answer of answers) {
        const id = Number(answer.questionId);

        if (
          !Number.isSafeInteger(id) ||
          submitted.has(id) ||
          !["CASH", "CARRE", "DUO"].includes(answer.mode) ||
          typeof answer.answer !== "string" ||
          answer.answer.length > 1000
        ) {
          return json(400, {
            error: "Une réponse est invalide.",
          });
        }

        submitted.set(id, answer);
      }

      const corrections = [];
      const storedAnswers = [];
      let total = 0;

      for (const question of questions) {
        const answer = submitted.get(question.id);

        if (!answer) {
          return json(400, {
            error: "Une question est restée sans réponse.",
          });
        }

        const accepted = Array.isArray(question.correct_answers)
          ? question.correct_answers
          : [];

        const correct = accepted.some(
          (value) => normalize(value) === normalize(answer.answer)
        );

        const basePoints = {
          CASH: 5,
          CARRE: 3,
          DUO: 1,
        }[answer.mode];

        const points = correct
          ? basePoints * (question.is_double ? 2 : 1)
          : 0;

        total += points;

        storedAnswers.push({
          question_id: question.id,
          selected_mode: answer.mode,
          answer_text: answer.answer,
          is_correct: correct,
          fragments_awarded: points,
        });

        corrections.push({
          questionNumber: question.question_number,
          question: question.question_text,
          yourAnswer: answer.answer,
          correct: correct,
          correctAnswer:
            question.correct_answer_display ||
            accepted.join(" / "),
          explanation: question.explanation || "",
          fragments: points,
        });
      }

      const submissions = await supabase("submissions?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          chapter_id: chapterId,
          discord_pseudo: pseudo,
          total_fragments: total,
        }),
      });

      const submissionId = submissions?.[0]?.id;

      if (!submissionId) {
        throw new Error("Enregistrement du résultat impossible.");
      }

      await supabase("answers", {
        method: "POST",
        body: JSON.stringify(
          storedAnswers.map((answer) => ({
            ...answer,
            submission_id: submissionId,
          }))
        ),
      });

      return json(200, {
        totalFragments: total,
        corrections,
      });
    }

    return json(400, { error: "Action inconnue." });
  } catch (error) {
    console.error(error);
    return json(500, {
      error: "Une erreur est survenue. Réessaie plus tard.",
    });
  }
};

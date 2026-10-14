
const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(data)
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

  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const body = await response.text();

  if (!response.ok) {
    console.error("Erreur Supabase :", response.status, body);
    throw new Error("La base de données a refusé la requête.");
  }

  return body ? JSON.parse(body) : null;
}

function getOptions(question) {
  if (!Array.isArray(question.options)) return [];

  return question.options.map((option) => {
    if (typeof option === "string" || typeof option === "number") {
      return String(option);
    }

    if (option && typeof option === "object") {
      return String(option.text ?? option.label ?? "");
    }

    return "";
  }).filter(Boolean);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function getPublishedChapter(chapterId) {
  const chapters = await supabase(
    `chapters?id=eq.${chapterId}&is_published=eq.true&select=id,title,volume_number,chapter_number`
  );

  return chapters[0] || null;
}

async function getAttempt(attemptId) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  ) {
    return null;
  }

  const rows = await supabase(
    `quiz_attempts?id=eq.${attemptId}&select=id,chapter_id,discord_pseudo,submitted_at`
  );

  return rows[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "La requête n'est pas un JSON valide." });
  }

  try {
    if (input.action === "health") {
      await supabase("chapters?select=id&limit=1");
      return json(200, {
        success: true,
        message: "Connexion Supabase réussie."
      });
    }

    const chapterId = Number(input.chapterId);

    if (!Number.isSafeInteger(chapterId) || chapterId < 1) {
      return json(400, { error: "Chapitre invalide." });
    }

    const chapter = await getPublishedChapter(chapterId);

    if (!chapter) {
      return json(404, { error: "Chapitre indisponible." });
    }

    const questions = await supabase(
      `questions?chapter_id=eq.${chapterId}&select=id,question_number,question_text,question_type,options,is_double&order=question_number.asc`
    );

    if (questions.length === 0) {
      return json(400, { error: "Ce chapitre ne contient aucune question." });
    }

    // Créer une tentative de quiz.
    if (input.action === "start") {
      const pseudo = String(input.pseudo || "").trim();

      if (!pseudo || pseudo.length > 50) {
        return json(400, { error: "Pseudo invalide." });
      }

      const attempts = await supabase("quiz_attempts?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          chapter_id: chapterId,
          discord_pseudo: pseudo
        })
      });

      if (!attempts?.[0]?.id) {
        throw new Error("Création de la tentative impossible.");
      }

      return json(200, {
        attemptId: attempts[0].id,
        chapter,
        questions
      });
    }

    const attempt = await getAttempt(input.attemptId);

    if (!attempt || Number(attempt.chapter_id) !== chapterId) {
      return json(400, { error: "Tentative invalide. Recharge le chapitre." });
    }

    if (attempt.submitted_at) {
      return json(409, { error: "Cette tentative a déjà été envoyée." });
    }

    // Enregistrer le mode avant de révéler les propositions.
    if (input.action === "chooseMode") {
      const questionId = Number(input.questionId);
      const mode = input.mode;

      if (!["CASH", "CARRE", "DUO"].includes(mode)) {
        return json(400, { error: "Mode invalide." });
      }

      const question = questions.find((q) => Number(q.id) === questionId);

      if (!question) {
        return json(400, { error: "Question invalide." });
      }

      const existing = await supabase(
        `quiz_attempt_modes?attempt_id=eq.${attempt.id}&question_id=eq.${questionId}&select=id,selected_mode,displayed_options`
      );

      // Le mode ne peut pas être modifié après son premier enregistrement.
      if (existing.length) {
        return json(200, {
          mode: existing[0].selected_mode,
          options: existing[0].displayed_options || [],
          locked: true
        });
      }

      const allOptions = getOptions(question);
      let displayedOptions = [];

      if (mode === "CARRE") {
        if (question.question_type === "free_text" || allOptions.length < 4) {
          return json(400, {
            error: "Le mode CARRÉ exige une question avec au moins quatre propositions."
          });
        }

        displayedOptions = allOptions;
      }

      if (mode === "DUO") {
        if (question.question_type === "free_text" || allOptions.length < 2) {
          return json(400, {
            error: "Le mode DUO exige une question à choix multiples."
          });
        }

        const fullQuestions = await supabase(
          `questions?id=eq.${questionId}&select=correct_answers`
        );

        const accepted = Array.isArray(fullQuestions[0]?.correct_answers)
          ? fullQuestions[0].correct_answers.map(normalize)
          : [];

        const correctOptions = allOptions.filter((option) =>
          accepted.includes(normalize(option))
        );

        if (!correctOptions.length) {
          return json(400, {
            error: "Le mode DUO ne peut pas être préparé : aucune proposition correcte ne correspond aux réponses enregistrées."
          });
        }

        const correctOption = randomItem(correctOptions);
        const distractors = allOptions.filter(
          (option) => normalize(option) !== normalize(correctOption)
        );

        if (!distractors.length) {
          return json(400, { error: "Propositions insuffisantes pour le mode DUO." });
        }

        displayedOptions = [correctOption, randomItem(distractors)];

        // Mélanger l'ordre des deux propositions.
        if (Math.random() < 0.5) {
          displayedOptions.reverse();
        }
      }

      // CASH ne révèle aucune proposition.
      await supabase("quiz_attempt_modes", {
        method: "POST",
        body: JSON.stringify({
          attempt_id: attempt.id,
          question_id: questionId,
          selected_mode: mode,
          displayed_options: displayedOptions
        })
      });

      return json(200, {
        mode,
        options: displayedOptions,
        locked: true
      });
    }

    // Corriger et enregistrer une tentative.
    if (input.action === "submit") {
      const answers = input.answers;

      if (!Array.isArray(answers) || answers.length !== questions.length) {
        return json(400, {
          error: "Le nombre de réponses ne correspond pas au quiz."
        });
      }

      const submitted = new Map();

      for (const answer of answers) {
        const id = Number(answer.questionId);

        if (
          !Number.isSafeInteger(id) ||
          submitted.has(id) ||
          typeof answer.answer !== "string" ||
          answer.answer.trim().length === 0 ||
          answer.answer.length > 1000
        ) {
          return json(400, { error: "Une réponse est invalide." });
        }

        submitted.set(id, answer);
      }

      const savedModes = await supabase(
        `quiz_attempt_modes?attempt_id=eq.${attempt.id}&select=question_id,selected_mode,displayed_options`
      );

      const modesByQuestion = new Map(
        savedModes.map((item) => [Number(item.question_id), item])
      );

      if (modesByQuestion.size !== questions.length) {
        return json(400, {
          error: "Choisis un mode pour chaque question avant de valider."
        });
      }

      const fullQuestions = await supabase(
        `questions?chapter_id=eq.${chapterId}&select=id,question_number,question_text,question_type,options,correct_answers,correct_answer_display,explanation,is_double&order=question_number.asc`
      );

      const corrections = [];
      const storedAnswers = [];
      let total = 0;

      for (const question of fullQuestions) {
        const answer = submitted.get(Number(question.id));
        const savedMode = modesByQuestion.get(Number(question.id));

        if (!answer || !savedMode) {
          return json(400, { error: "Une question est incomplète." });
        }

        if (answer.mode !== savedMode.selected_mode) {
          return json(400, {
            error: "Un mode ne correspond pas au choix enregistré. Recharge le quiz."
          });
        }

        const mode = savedMode.selected_mode;
        const responseText = answer.answer.trim();

        if (mode === "CARRE" || mode === "DUO") {
          const shownOptions = Array.isArray(savedMode.displayed_options)
            ? savedMode.displayed_options
            : [];

          if (!shownOptions.some((option) => option === responseText)) {
            return json(400, {
              error: "La réponse ne fait pas partie des propositions affichées."
            });
          }
        }

        const accepted = Array.isArray(question.correct_answers)
          ? question.correct_answers
          : [];

        const correct = accepted.some(
          (value) => normalize(value) === normalize(responseText)
        );

        const basePoints = { CASH: 5, CARRE: 3, DUO: 1 }[mode];
        const points = correct
          ? basePoints * (question.is_double ? 2 : 1)
          : 0;

        total += points;

        storedAnswers.push({
          question_id: question.id,
          selected_mode: mode,
          answer_text: responseText,
          is_correct: correct,
          fragments_awarded: points
        });

        corrections.push({
          questionNumber: question.question_number,
          question: question.question_text,
          yourAnswer: responseText,
          correct,
          correctAnswer:
            question.correct_answer_display || accepted.join(" / "),
          explanation: question.explanation || "",
          fragments: points
        });
      }

      const submissions = await supabase("submissions?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          chapter_id: chapterId,
          discord_pseudo: attempt.discord_pseudo,
          total_fragments: total
        })
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
            submission_id: submissionId
          }))
        )
      });

      await supabase(`quiz_attempts?id=eq.${attempt.id}`, {
        method: "PATCH",
        body: JSON.stringify({ submitted_at: new Date().toISOString() })
      });

      return json(200, {
        totalFragments: total,
        corrections
      });
    }

    return json(400, { error: "Action inconnue." });

  } catch (error) {
    console.error("Erreur quiz :", error);

    return json(500, {
      error: "Une erreur est survenue. Réessaie plus tard."
    });
  }
};

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(data)
});

// Normalisation des pseudos : casse, accents, espaces et ponctuation ignorés.
const normalize = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]/g, "");

async function supabase(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Configuration Supabase manquante.");
  }

  const response = await fetch(url + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const body = await response.text();

  if (!response.ok) {
    console.error("Erreur Supabase :", response.status, body);

    let details = {};
    try {
      details = body ? JSON.parse(body) : {};
    } catch {
      // Le corps de l'erreur n'est pas nécessairement du JSON.
    }

    const error = new Error("La base de données a refusé la requête.");
    error.status = response.status;
    error.code = details.code || null;
    error.details = details.details || null;
    error.messageFromDatabase = details.message || null;

    throw error;
  }

  return body ? JSON.parse(body) : null;
}

function getOptions(question) {
  if (!Array.isArray(question.options)) return [];

  return question.options
    .map((option) => {
      if (typeof option === "string" || typeof option === "number") {
        return String(option);
      }

      if (option && typeof option === "object") {
        return String(option.text ?? option.label ?? "");
      }

      return "";
    })
    .filter(Boolean);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function getPublishedChapter(chapterId) {
  const chapters = await supabase(
    "chapters?id=eq." + chapterId + "&is_published=eq.true&select=id,title,volume_number,chapter_number"
  );

  return chapters[0] || null;
}

// Vérifie si le pseudo a déjà un résultat pour ce chapitre.
async function hasSubmittedChapter(chapterId, pseudo) {
  const rows = await supabase(
    "submissions?chapter_id=eq." + chapterId + "&select=discord_pseudo"
  );

  const wantedPseudo = normalize(pseudo);

  return rows.some(
    (row) => normalize(row.discord_pseudo) === wantedPseudo
  );
}

async function getAttempt(attemptId) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  ) {
    return null;
  }

  const rows = await supabase(
    "quiz_attempts?id=eq." + attemptId + "&select=id,chapter_id,discord_pseudo,submitted_at"
  );

  return rows[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Méthode non autorisée."
    });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, {
      error: "La requête n'est pas un JSON valide."
    });
  }

  try {
    // Vérifier la connexion à Supabase.
    if (input.action === "health") {
      await supabase("chapters?select=id&limit=1");

      return json(200, {
        success: true,
        message: "Connexion Supabase réussie."
      });
    }

    // Liste des chapitres.
    if (input.action === "listChapters") {
      const chapters = await supabase(
        "chapters?select=id,title,volume_number,chapter_number,is_published&order=volume_number.asc,chapter_number.asc"
      );

      return json(200, { chapters });
    }

    const chapterId = Number(input.chapterId);

    if (!Number.isSafeInteger(chapterId) || chapterId < 1) {
      return json(400, {
        error: "Chapitre invalide."
      });
    }

    const chapter = await getPublishedChapter(chapterId);

    if (!chapter) {
      return json(404, {
        error: "Chapitre indisponible."
      });
    }

    const questions = await supabase(
      "questions?chapter_id=eq." + chapterId + "&select=id,question_number,question_text,question_type,options,is_double&order=question_number.asc"
    );

    if (!questions.length) {
      return json(400, {
        error: "Ce chapitre ne contient aucune question."
      });
    }

    // Démarrer une tentative.
    if (input.action === "start") {
      const pseudo = String(input.pseudo || "").trim();

      if (!pseudo || pseudo.length > 50 || !normalize(pseudo)) {
        return json(400, {
          error: "Pseudo invalide."
        });
      }

      if (await hasSubmittedChapter(chapterId, pseudo)) {
        return json(409, {
          error: "Tu as déjà envoyé tes réponses pour ce chapitre. Ton premier résultat reste définitif."
        });
      }

      const attempts = await supabase("quiz_attempts?select=id", {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          chapter_id: chapterId,
          discord_pseudo: pseudo
        })
      });

      if (!attempts?.[0]?.id) {
        throw new Error("Création de la tentative impossible.");

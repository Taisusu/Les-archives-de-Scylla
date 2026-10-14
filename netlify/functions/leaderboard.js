```javascript
const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(data)
});

async function supabase(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Configuration Supabase manquante.");
  }

  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    }
  });

  const body = await response.text();

  if (!response.ok) {
    console.error(
      "Erreur Supabase classement :",
      response.status,
      body
    );

    throw new Error("Impossible de récupérer les classements.");
  }

  return body ? JSON.parse(body) : null;
}

// Normalisation alignée sur la règle SQL :
// minuscules, accents courants supprimés, espaces et ponctuation ignorés.
function normalizePseudo(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9à-ÿ]/g, "")
    .replace(/[àáâãäåāăą]/g, "a")
    .replace(/[èéêëēėęě]/g, "e")
    .replace(/[ìíîïīįı]/g, "i")
    .replace(/[òóôõöøōő]/g, "o")
    .replace(/[ùúûüūůűų]/g, "u")
    .replace(/[çćč]/g, "c")
    .replace(/[ñńň]/g, "n")
    .replace(/[ýÿ]/g, "y");
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
    // Liste des chapitres publiés.
    if (input.action === "listChapters") {
      const chapters = await supabase(
        "chapters?is_published=eq.true&select=id,title,volume_number,chapter_number&order=volume_number.asc,chapter_number.asc"
      );

      return json(200, { chapters });
    }

    // Classement d'un chapitre.
    if (input.action === "chapterRanking") {
      const chapterId = Number(input.chapterId);

      if (!Number.isSafeInteger(chapterId) || chapterId < 1) {
        return json(400, {
          error: "Chapitre invalide."
        });
      }

      // Vérifier que le chapitre existe et est publié.
      const chapters = await supabase(
        `chapters?id=eq.${chapterId}&is_published=eq.true&select=id,title,volume_number,chapter_number`
      );

      const chapter = chapters[0];

      if (!chapter) {
        return json(404, {
          error: "Chapitre indisponible."
        });
      }

      // Le premier résultat est déterminé par la date d'envoi,
      // avec l'identifiant comme départage déterministe.
      const submissions = await supabase(
        `submissions?chapter_id=eq.${chapterId}&select=id,discord_pseudo,total_fragments,submitted_at&order=submitted_at.asc,id.asc`
      );

      // Garder uniquement la première soumission de chaque pseudo.
      const firstScores = new Map();

      for (const submission of submissions || []) {
        const pseudo = String(
          submission.discord_pseudo ?? ""
        ).trim();

        const key = normalizePseudo(pseudo);
        const score = Number(submission.total_fragments);

        if (!pseudo || !key || !Number.isFinite(score)) {
          continue;
        }

        if (!firstScores.has(key)) {
          firstScores.set(key, {
            pseudo,
            totalFragments: score
          });
        }
      }

      // Trier les joueurs par leur premier score.
      const sorted = Array.from(firstScores.values()).sort(
        (a, b) =>
          b.totalFragments - a.totalFragments ||
          a.pseudo.localeCompare(b.pseudo, "fr", {
            sensitivity: "base"
          })
      );

      // Ex æquo : même score = même rang.
      let previousScore = null;
      let currentRank = 0;

      const ranking = sorted.map((player, index) => {
        if (player.totalFragments !== previousScore) {
          currentRank = index + 1;
          previousScore = player.totalFragments;
        }

        return {
          rank: currentRank,
          pseudo: player.pseudo,
          totalFragments: player.totalFragments
        };
      });

      return json(200, {
        chapter,
        ranking
      });
    }

    return json(400, {
      error: "Action inconnue."
    });

  } catch (error) {
    console.error("Erreur classement :", error);

    return json(500, {
      error: "Impossible de charger les classements pour le moment."
    });
  }
};
```

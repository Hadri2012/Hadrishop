# HADRISHOP — boutique d'impressions 3D (Firebase)

Boutique en ligne complète : catalogue, comptes clients, panier, paiements **Stripe Checkout**, livraison par codes postaux et rayon de 30 km, commandes sur mesure, vente de fichiers STL, Premium, newsletter et interface **/admin**.

Hébergement gratuit **Render + Firestore** (section 3), ou **Firebase Blaze** (section 3 bis) : une Cloud Function `api` (Express, région europe-west1) sert tout le site via Firebase Hosting ; données dans **Cloud Firestore**, fichiers dans **Cloud Storage** ; une fonction planifiée `jobs` tourne chaque minute (libération des réservations expirées, envoi des e-mails, nettoyage). Toute la logique sensible s'exécute côté serveur ; les règles Firestore/Storage interdisent tout accès direct depuis les navigateurs.

```
render.yaml                Render (serveur gratuit)
firebase.json              configuration Firebase Blaze (Hosting → fonction api, règles)
firestore.rules            accès direct interdit
storage.rules              accès direct interdit
hosting/robots.txt
functions/                 code serveur + pages (public/index.html, public/admin.html)
.github/workflows/deploy.yml   tests puis déploiement à chaque push sur main
```

---

## 1. Ce qui est inclus

| Fonction | Où |
|---|---|
| Catalogue : photos, catégories, recherche, tri, variantes, stocks | Boutique `/` · Admin › Produits, Catégories |
| Comptes : inscription, confirmation d'e-mail, connexion, mot de passe oublié, suppression du compte | Boutique › Compte |
| Historique et suivi de commande (chronologie, n° de colis, e-mail à chaque étape) | Compte › Commandes · Admin › Commandes |
| Panier, codes promo (%, montant fixe, minimum, limites globale/par client, dates, réservé Premium) | Panier · Admin › Codes promo |
| Réservation du stock **15 minutes** pendant le paiement | automatique (tâche planifiée chaque minute + contrôle à chaque achat) |
| Paiement Stripe Checkout, webhooks signés, remboursements partiels/complets | Admin › Commandes, Remboursements |
| Livraison : retrait, liste de codes postaux, rayon autour de l'atelier (30 km par défaut) | Panier · Admin › Livraison |
| Commandes sur mesure (fichiers STL/3MF/OBJ/photos, devis, paiement) | Sur mesure · Admin › Sur mesure |
| Fichiers STL numériques (téléchargement sécurisé, nombre limité, révoqué si remboursé) | Compte › Téléchargements |
| Modification d'adresse (client : avant expédition et dans la même zone ; admin : toujours) | Commande · Admin › Commande |
| Premium (abonnement Stripe : remise, livraison offerte, produits réservés) | Premium · Admin › Paramètres, Clients |
| Newsletter (double confirmation, désinscription en un clic, campagnes) | Pied de page · Admin › Newsletter |
| Tableau de bord : ventes nettes par jour, KPI, meilleures ventes, stock bas, à traiter | Admin › Tableau de bord |
| Journal des actions admin et des événements Stripe, file d'e-mails | Admin › Journal, E-mails |

## 2. Sécurité et fiabilité (résumé)

- **Paiements** : montants calculés uniquement côté serveur ; webhook Stripe vérifié par signature sur le corps brut ; chaque événement est traité une seule fois (collection `stripe_events`, réservée dans une transaction) ; une commande ne peut passer « payée » qu'une fois (état vérifié dans une transaction).
- **Double paiement** : clé de paiement par tentative (double clic = même session Stripe), une seule commande en attente par client (la précédente est annulée et sa session Stripe expirée), clés d'idempotence sur toutes les créations Stripe, une seule session Premium ouverte à la fois.
- **Stock** : réservation et décompte dans des transactions Firestore qui relisent la variante (deux achats concurrents ne peuvent pas valider ensemble) ; le stock n'est jamais écrit en dessous de 0. Test : 12 achats simultanés pour 5 articles → exactement 5 réussites.
- **Réservation de 15 min** : Stripe impose une expiration de session d'au moins 30 min ; le serveur libère donc lui-même le stock après 15 min et expire la session Stripe. Si un paiement arrive malgré tout après l'expiration : la commande est honorée si le stock est encore libre, sinon elle est annulée et **remboursée automatiquement**.
- **Remboursements** : jamais au-delà du montant payé (remboursements en cours inclus, même en parallèle) ; remise en stock possible sur le solde ; remboursements faits depuis le Dashboard Stripe rattrapés par webhook.
- **Comptes** : mots de passe hachés avec scrypt (paramètres OWASP N=2¹⁵, r=8, p=3), sessions aléatoires stockées hachées, cookie `__session` `HttpOnly` + `SameSite=Lax` (+ `Secure` en HTTPS), limitation des tentatives, réinitialisation à usage unique qui déconnecte tous les appareils, pas d'énumération des comptes.
- **Web** : protection CSRF (en-tête dédié + contrôle d'origine), CSP stricte (scripts autorisés par empreinte SHA-256, aucun `unsafe-inline` pour les scripts), `frame-ancestors 'none'`, téléversements validés par leur contenu réel (une image SVG/HTML déguisée est refusée), fichiers privés jamais servis publiquement, erreurs internes masquées.
- **Admin** : toutes les routes `/api/admin/*` exigent le rôle admin (test automatique sur chaque route), actions sensibles journalisées.

## 3. Mise en ligne gratuite, sans carte bancaire : Render + Firestore

- **Serveur** : Render, service web gratuit (`render.yaml`). Il s'endort après 15 min sans visite ; le visiteur suivant attend environ 1 minute.
- **Données et fichiers** : Firestore, projet Firebase gratuit **Spark** (aucun moyen de paiement). Les images et STL sont stockés dans Firestore, découpés en morceaux (Cloud Storage exige le forfait payant).

**A. Firebase (sans carte)** — https://console.firebase.google.com
1. Créer un projet (rester sur le forfait gratuit Spark).
2. Firestore Database › Créer une base › **mode production** › emplacement en Europe (ex. `eur3` ou `europe-west1`). Le mode production interdit tout accès direct depuis les navigateurs.
3. ⚙️ Paramètres du projet › Comptes de service › **Générer une nouvelle clé privée** → un fichier JSON se télécharge. **Ne le commitez jamais.**

**B. Render (sans carte)** — https://render.com
1. S'inscrire avec GitHub.
2. New › **Blueprint** › choisir le dépôt `hadrishop` (Render lit `render.yaml`).
3. Remplir les valeurs demandées :

| Variable | Valeur |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | tout le contenu du fichier JSON de l'étape A.3 |
| `ADMIN_EMAIL` | votre adresse : ce compte devient administrateur dès qu'il confirme son e-mail |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | clés Stripe de test (étape 5) |
| `SMTP_URL`, `MAIL_FROM`, `ADMIN_NOTIFY_EMAIL` | e-mails (étape 6) |

4. Le site est en ligne sur `https://hadrishop.onrender.com` (ou le nom affiché par Render). L'adresse est détectée automatiquement (`RENDER_EXTERNAL_URL`) ; mettez `APP_URL` seulement pour un nom de domaine à vous.
5. Premier administrateur : créer un compte avec l'adresse `ADMIN_EMAIL`, cliquer le lien de confirmation, ouvrir `/admin`.

Chaque `push` sur `main` redéploie automatiquement. Sans clé Stripe, la boutique refuse tout paiement (aucun paiement n'est simulé).

**Limites de l'offre gratuite** : Firestore gratuit = 1 Gio de données (fichiers compris), 50 000 lectures et 20 000 écritures par jour ; au-delà, Firestore est coupé jusqu'à la fin de la période. Render gratuit = mise en veille, bande passante limitée. Les tâches de fond (réservations, e-mails) tournent chaque minute uniquement quand le serveur est éveillé ; le stock est de toute façon revérifié à chaque achat (une réservation expirée ne bloque jamais un article).

## 3 bis. Variante Firebase Blaze (carte bancaire requise)


Tout se fait dans le navigateur ; ensuite, chaque `push` sur `main` teste et redéploie automatiquement.

**A. Projet Firebase** (https://console.firebase.google.com)
1. Créer le projet (noter son **ID**, ex. `hadrishop-1a2b3`).
2. Passer au forfait **Blaze** (carte bancaire requise ; facturation à l'usage au-delà des quotas gratuits — voir Sources). Conseillé : créer une **alerte de budget** dans Google Cloud › Facturation › Budgets.
3. **Firestore Database** › Créer une base, mode production, emplacement `europe-west1`.
4. **Storage** › Commencer, mode production, même région si proposée.

**B. Compte de service pour GitHub** (https://console.cloud.google.com/iam-admin/serviceaccounts, projet sélectionné)
1. Créer un compte de service `github-deploy`.
2. Lui donner les rôles : *Firebase Admin*, *Cloud Functions Admin*, *Service Account User*, *Cloud Scheduler Admin*, *Artifact Registry Administrator*, *Cloud Run Viewer*, *API Keys Viewer*.
3. Onglet Clés › Ajouter une clé › JSON → un fichier se télécharge. **Ne le commitez jamais.**

**C. Secrets GitHub** (dépôt › Settings › Secrets and variables › Actions › New repository secret)

| Secret | Valeur |
|---|---|
| `FIREBASE_PROJECT_ID` | l'ID du projet |
| `FIREBASE_SERVICE_ACCOUNT` | tout le contenu du fichier JSON de l'étape B |
| `ADMIN_EMAIL` | votre adresse : ce compte devient administrateur dès qu'il confirme son e-mail |
| `STRIPE_SECRET_KEY` | `sk_test_…` (étape 5) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (étape 5) |
| `SMTP_URL` | `smtps://utilisateur:motdepasse@serveur:465` |
| `MAIL_FROM` | `HADRISHOP <boutique@exemple.be>` |
| `ADMIN_NOTIFY_EMAIL` | adresse qui reçoit les alertes |
| `APP_URL` *(facultatif)* | par défaut `https://ID.web.app` |
| `GEOCODER`, `GEOCODER_CONTACT` *(facultatifs)* | voir étape 7 |

Ces valeurs ne sont jamais écrites dans le dépôt : le workflow génère `functions/.env` le temps du déploiement puis l'efface.

**D. Déployer** : onglet Actions › « Tests et déploiement Firebase » › Run workflow (ou tout `push` sur `main`). Le site est ensuite sur `https://ID.web.app`.

**E. Premier administrateur** : créez un compte sur la boutique avec l'adresse `ADMIN_EMAIL`, cliquez le lien de confirmation reçu par e-mail, puis ouvrez `/admin`. (Sans SMTP configuré, aucun e-mail ne part : configurez `SMTP_URL` d'abord.)

Sans clé Stripe, la boutique fonctionne en vitrine mais **refuse tout paiement** (aucun paiement n'est simulé).

## 4. Limites connues

- Taille d'une requête limitée par Cloud Functions : images 10 Mo, fichiers sur mesure 25 Mo, fichiers STL 30 Mo.
- La limitation des tentatives de connexion est comptée par instance de serveur (5 instances au maximum).
- La tâche planifiée tourne chaque minute : une réservation peut être libérée jusqu'à ~1 minute après ses 15 minutes (le stock est de toute façon revérifié à chaque achat).
- Les tests automatiques utilisent une base Firestore simulée en mémoire (l'émulateur officiel n'était pas téléchargeable dans l'environnement de développement) : vérifiez le parcours complet en mode test Stripe après le premier déploiement.

## 5. Configuration de Stripe

1. **Clés API** : Dashboard Stripe › Développeurs › Clés API → le secret GitHub `STRIPE_SECRET_KEY` (commencez par `sk_test_…`).
2. **Webhook** : Dashboard › Développeurs › Webhooks › Ajouter un endpoint : `https://ID-DU-PROJET.web.app/api/stripe/webhook`, avec les événements :
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `refund.updated`, `refund.failed`, `charge.refunded` (et `refund.created` s'il est proposé)

   Copiez le secret de signature dans le secret GitHub `STRIPE_WEBHOOK_SECRET`.
3. **Moyens de paiement** (cartes, Bancontact, etc.) : à activer dans Dashboard › Paramètres › Moyens de paiement ; Checkout affiche automatiquement ceux qui sont actifs.
4. Passage en production : remplacez la clé et le secret par ceux du mode **live** et recréez l'endpoint webhook en mode live.

## 6. E-mails

Tout fournisseur SMTP convient. Les e-mails sont mis en file d'attente dans Firestore et réessayés automatiquement ; leur état est visible dans Admin › E-mails (bouton « M'envoyer un e-mail de test »). Twilio et SendGrid (société Twilio) ne sont pas utilisés.

## 7. Livraison par rayon de 30 km

1. Admin › Livraison : saisissez la **latitude/longitude de l'atelier** (le catalogue de démo met Bruxelles à titre d'exemple).
2. Rendez les codes postaux localisables, au choix :
   - importer le fichier GeoNames belge : téléchargez `BE.zip` sur `https://download.geonames.org/export/zip/`, extrayez `BE.txt`, puis Admin › Livraison › Importer. Licence CC BY 4.0 : mentionnez GeoNames.
   - ou le secret GitHub `GEOCODER` = `nominatim` : géocodage OpenStreetMap à la demande, limité à 1 requête/seconde et mis en cache, conformément à la politique d'usage de Nominatim.
3. Un code postal impossible à localiser n'est jamais accepté par erreur : la zone « rayon » est simplement indisponible pour lui.

## 8. Développement et tests

```bash
cd functions
npm ci
npm test          # 50 tests API : paiement, concurrence, webhooks, remboursements, sécurité, fonctionnalités
npm run test:e2e  # 5 tests dans Chrome (CHROME_PATH=/chemin/vers/chrome si besoin)
```
Les tests utilisent un faux client Stripe (aucun appel réseau, aucun paiement) ; les webhooks sont signés et vérifiés avec la vraie bibliothèque Stripe. Ils tournent aussi sur GitHub avant chaque déploiement.

## 9. Coûts

Le forfait Blaze inclut des quotas gratuits (Functions, Firestore, Storage, Hosting) ; une petite boutique peut rester dedans, mais **je ne peux pas le garantir** : cela dépend du trafic. Postes payants possibles même à faible trafic : stockage des images de conteneur des fonctions (Artifact Registry) et dépassement des quotas. Les frais Stripe s'appliquent à chaque paiement.

## 10. À faire avant d'ouvrir la boutique

- Rédiger les **conditions générales de vente**, les mentions légales et la politique de confidentialité (Admin › Paramètres) — à faire valider, ce code n'est pas un conseil juridique.
- Prix affichés TVAC ; aucune facture n'est générée par l'application (les reçus Stripe peuvent être activés dans le Dashboard Stripe).
- Pas de double authentification (2FA) sur /admin : utilisez un mot de passe long et unique.
- Remplacer le catalogue et les illustrations d'exemple par vos produits et photos.

## Sources

- Firebase — forfait Spark sans moyen de paiement, quotas Firestore : https://firebase.google.com/pricing
- Firebase — Cloud Storage exige Blaze : https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024
- Render — offre gratuite (veille après 15 min, base Postgres temporaire) : https://render.com/docs/free

- Stripe — expiration des sessions Checkout (30 min minimum) : https://docs.stripe.com/payments/checkout/abandoned-carts
- Stripe — gestion d'un stock limité et expiration manuelle : https://docs.stripe.com/payments/checkout/managing-limited-inventory
- Stripe — webhooks (signature sur corps brut, événements dupliqués) : https://docs.stripe.com/webhooks
- Stripe — période d'abonnement déplacée sur les items (API Basil) : https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- Stripe — suppression de `payment_method_types` pour Checkout (API Endive) : https://docs.stripe.com/changelog/endive
- Stripe — remboursements asynchrones (`refund.updated`, `refund.failed`) : https://docs.stripe.com/testing
- OWASP — stockage des mots de passe (scrypt) : https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Nominatim — politique d'usage : https://operations.osmfoundation.org/policies/nominatim/
- Elegoo Neptune 4 Pro — volume d'impression 225 × 225 × 265 mm (valeur par défaut du formulaire sur mesure) : https://www.elegoo.com/collections/pre-owned-3d-printer/products/elegoo-neptune-4-pro-fdm-3d-printer
- Firebase — Hosting + Cloud Functions (réécritures, région europe-west1 recommandée) : https://firebase.google.com/docs/hosting/functions
- Firebase — seul le cookie `__session` est transmis aux fonctions : https://firebase.google.com/docs/hosting/manage-cache#using_cookies
- Firebase — variables d'environnement (`functions/.env`) : https://firebase.google.com/docs/functions/config-env
- Firebase — tarifs et quotas gratuits du forfait Blaze : https://firebase.google.com/pricing
- Cloud Functions — régions : https://firebase.google.com/docs/functions/locations
- firebase-tools — authentification CI par `GOOGLE_APPLICATION_CREDENTIALS` : https://github.com/firebase/firebase-tools#using-with-ci-systems


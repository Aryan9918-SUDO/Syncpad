const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const {
  createDocument,
  listDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
  addCollaborator,
  getCollaborators,
  removeCollaborator,
  searchUsers,
} = require('../controllers/documents');

const router = Router();

router.use(authenticate);

router.get('/search-users', searchUsers);
router.post('/', createDocument);
router.get('/', listDocuments);
router.get('/:id', getDocument);
router.put('/:id', updateDocument);
router.delete('/:id', deleteDocument);
router.post('/:id/collaborators', addCollaborator);
router.get('/:id/collaborators', getCollaborators);
router.delete('/:id/collaborators/:userId', removeCollaborator);

module.exports = router;

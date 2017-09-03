const multer = require('multer'),
	upload = multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: 3145728 },
		fileFilter(req, file, cb) {
			if (!['png', 'jpg', 'jpeg'].includes(file.mimetype.replace('image/', '')))
				return cb('Invalid file type');
			return cb(null, true);
		}
	}).single('image'),
	sharp = require('sharp'),
	shortid = require('shortid'),
	md5 = require('md5'),
	RateLimiter = require('../../../structures/RateLimiter');

class ImagesPOST {
	constructor(controller, settings) {
		this.path = '/images';
		this.router = controller.router;
		this.database = controller.database;
		this.authorize = controller.authorize;

		this.allowImageUploads = settings.allowImageUploads;
		this.imageSaveQuality = settings.imageSaveQuality;
		this.thumbnailSaveQuality = settings.thumbnailSaveQuality;
		this.imageMaxWidth = settings.imageMaxWidth;
		this.imageMaxHeight = settings.imageMaxHeight;

		this.rateLimiter = new RateLimiter({ max: 2 }); // 2/10 limit

		this.router.post(
			this.path,
			this.rateLimiter.limit.bind(this.rateLimiter),
			this.authorize.bind(this),
			this.run.bind(this)
		);
	}

	async run(req, res) {
		if (!this.allowImageUploads && !req.user.roles.includes('admin')) {
			this.rateLimiter.unlimit(req, res);
			return res.status(403).send({ message: "Image uploads not allowed" });
		}

		upload(req, res, async error => {
			if (error)
				return res.status(400).send({ message: error });

			if (req.body.tags) {
				// Remove spaces around commas. Also convert _ and - to space
				req.body.tags = req.body.tags.replace(/( *,[ ,]*(\r?\n)*|\r\n+|\n+)/g, ',').replace(/[-_]/g, ' ');

				if (req.body.tags.split(',').length > 50)
					return res.status(400).send({ message: "A post can only have up to 50 tags" });

				if (req.body.tags.split(',').find(t => t.length > 40))
					return res.status(400).send({ message: "Tags have a maximum length of 40 characters" });
			}

			if (req.body.artist) {
				req.body.artist = req.body.artist.replace(/_/g, ' ');

				if (req.body.artist.length > 30)
					return res.status(400).send({ message: "The artist field has a maximum length of 30 characters" });
			}

			if (!req.file || !req.body)
				return res.status(400).send({ message: "No image and/or form attached" });

			let originalHash = md5(req.file.buffer);

			// Check if it's a duplicate
			let existing = await this.database.Image.findOne({ originalHash });
			if (existing)
				return res.status(409).send({ message: "Image already uploaded", id: existing.id });

			let filename = shortid.generate();

			await sharp(req.file.buffer)
				.resize(360, 420)
				.max()
				.withoutEnlargement()
				.background({ r: 255, g: 255, b: 255, alpha: 1 })
				.flatten()
				.jpeg({ quality: this.thumbnailSaveQuality })
				.toFile(`${__dirname}/../../../thumbnail/${filename}.jpg`);

			return sharp(req.file.buffer)
				.resize(this.imageMaxWidth, this.imageMaxHeight)
				.max()
				.withoutEnlargement()
				.background({ r: 255, g: 255, b: 255, alpha: 1 })
				.flatten()
				.jpeg({ quality: this.imageSaveQuality })
				.toFile(`${__dirname}/../../../image/${filename}.jpg`)
				.then(async () => {
					let image = await this.database.Image.create({
						id: filename,
						originalHash,
						uploader: {
							id: req.user.id,
							username: req.user.username
						},
						nsfw: !!req.body.nsfw,
						artist: req.body.artist || undefined,
						tags: req.body.tags || '',
						comments: []
					});

					req.user.uploads = req.user.uploads + 1;
					await req.user.save();

					return res.status(201).location(`/image/${filename}.jpg`).send({
						image: {
							id: image.id,
							createdAt: image.createdAt,
							uploader: image.uploader,
							tags: image.tags,
							artist: image.artist,
							nsfw: image.nsfw
						},
						image_url: `https://nekos.brussell.me/image/${filename}.jpg`,
						post_url: `https://nekos.brussell.me/post/${filename}`
					});
				}).catch(error => {
					console.error(error);
					return res.status(500).send({ message: 'Error saving image' });
				});
		});
	}
}

module.exports = ImagesPOST;
